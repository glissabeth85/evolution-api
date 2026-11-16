import { PrismaRepository } from '@api/repository/repository.service';
import { WAMonitoringService } from '@api/services/monitor.service';
import { Auth, configService, Cors, Log, Websocket } from '@config/env.config';
import { Logger } from '@config/logger.config';
import { safeCompare } from '@utils/requestPath';
import { Server } from 'http';
import { Server as SocketIO, Socket } from 'socket.io';

import { EmitData, EventController, EventControllerInterface } from '../event.controller';

export class WebsocketController extends EventController implements EventControllerInterface {
  private io: SocketIO;
  private corsConfig: Array<any>;
  private readonly logger = new Logger('WebsocketController');

  constructor(prismaRepository: PrismaRepository, waMonitor: WAMonitoringService) {
    super(prismaRepository, waMonitor, configService.get<Websocket>('WEBSOCKET')?.ENABLED, 'websocket');

    this.cors = configService.get<Cors>('CORS').ORIGIN;
  }

  public init(httpServer: Server): void {
    if (!this.status) {
      return;
    }

    this.socket = new SocketIO(httpServer, {
      cors: { origin: this.cors },
      // Transport-level check: rejects requests with no valid key early.
      // Per-namespace authorization is enforced below in authorizeNamespace().
      allowRequest: async (req, callback) => {
        try {
          const url = new URL(req.url || '', 'http://localhost');
          const params = new URLSearchParams(url.search);

          if (params.has('EIO') && this.isTrustedHost(req.socket.remoteAddress)) {
            return callback(null, true);
          }

          const apiKey = params.get('apikey') || (req.headers.apikey as string);

          if (!apiKey) {
            this.logger.error('Connection rejected: apiKey not provided');
            return callback('apiKey is required', false);
          }

          if (!(await this.resolveKey(apiKey))) {
            this.logger.error('Connection rejected: invalid api key');
            return callback('Invalid api key', false);
          }

          callback(null, true);
        } catch (error) {
          this.logger.error('Authentication error:');
          this.logger.error(error);
          callback('Authentication error', false);
        }
      },
    });

    // Tenant isolation: an instance token may only join its own namespace (/<instanceName>).
    // The global namespace "/" receives every tenant's events when GLOBAL_EVENTS is on, so it
    // then requires the global key. Covers the main namespace and every namespace created later.
    this.socket.use((socket, next) => this.authorizeNamespace(socket, next));
    this.socket.on('new_namespace', (nsp) => nsp.use((socket, next) => this.authorizeNamespace(socket, next)));

    this.socket.on('connection', (socket) => {
      this.logger.info('User connected');

      socket.on('disconnect', () => {
        this.logger.info('User disconnected');
      });

      socket.on('sendNode', async (data) => {
        try {
          const target = data?.instanceId;
          // Raw stanzas may only be sent as the instance the socket authenticated for.
          if (!socket.data?.isGlobal && socket.data?.instanceName !== target) {
            this.logger.error('sendNode rejected: socket not authorized for this instance');
            return;
          }

          await this.waMonitor.waInstances[target].baileysSendNode(data.stanza);
          this.logger.info('Node sent successfully');
        } catch (error) {
          this.logger.error('Error sending node:');
          this.logger.error(error);
        }
      });
    });

    this.logger.info('Socket.io initialized');
  }

  private isTrustedHost(remoteAddress?: string): boolean {
    const allowedHosts = configService.get<Websocket>('WEBSOCKET').ALLOWED_HOSTS || '127.0.0.1,::1,::ffff:127.0.0.1';
    if (allowedHosts.trim() === '*') return true;
    return allowedHosts
      .split(',')
      .map((h) => h.trim())
      .includes(remoteAddress);
  }

  /** Returns { isGlobal } for the global key, { instanceName } for an instance token, or null. */
  private async resolveKey(apiKey?: string): Promise<{ isGlobal: boolean; instanceName?: string } | null> {
    if (!apiKey) return null;

    if (safeCompare(apiKey, configService.get<Auth>('AUTHENTICATION').API_KEY.KEY)) {
      return { isGlobal: true };
    }

    const instance = await this.prismaRepository.instance.findFirst({
      where: { token: apiKey },
      select: { name: true },
    });

    return instance ? { isGlobal: false, instanceName: instance.name } : null;
  }

  private async authorizeNamespace(socket: Socket, next: (err?: Error) => void) {
    try {
      const handshake = socket.handshake;
      const apiKey =
        (handshake.auth?.apikey as string) ||
        (handshake.query?.apikey as string) ||
        (handshake.headers?.apikey as string);
      const nspName = socket.nsp.name;

      const identity = await this.resolveKey(apiKey);

      if (!identity) {
        // Keep the historical behaviour for trusted local hosts that connect without a key.
        if (!apiKey && this.isTrustedHost(socket.conn.remoteAddress)) {
          socket.data.isGlobal = true;
          return next();
        }
        return next(new Error('Unauthorized'));
      }

      if (identity.isGlobal) {
        socket.data.isGlobal = true;
        return next();
      }

      if (nspName === '/') {
        if (configService.get<Websocket>('WEBSOCKET')?.GLOBAL_EVENTS) {
          return next(new Error('Global events require the global api key'));
        }
      } else if (nspName !== `/${identity.instanceName}`) {
        this.logger.error(`Namespace ${nspName} rejected for instance token of ${identity.instanceName}`);
        return next(new Error('Unauthorized for this instance'));
      }

      socket.data.instanceName = identity.instanceName;
      return next();
    } catch (error) {
      this.logger.error(['Namespace authorization error', error?.message]);
      return next(new Error('Authentication error'));
    }
  }

  private set cors(cors: Array<any>) {
    this.corsConfig = cors;
  }

  private get cors(): string | Array<any> {
    return this.corsConfig?.includes('*') ? '*' : this.corsConfig;
  }

  private set socket(socket: SocketIO) {
    this.io = socket;
  }

  public get socket(): SocketIO {
    return this.io;
  }

  public async emit({
    instanceName,
    origin,
    event,
    data,
    serverUrl,
    dateTime,
    sender,
    apiKey,
    integration,
    extra,
  }: EmitData): Promise<void> {
    if (integration && !integration.includes('websocket')) {
      return;
    }

    if (!this.status) {
      return;
    }

    const configEv = event.replace(/[.-]/gm, '_').toUpperCase();
    const logEnabled = configService.get<Log>('LOG').LEVEL.includes('WEBSOCKET');
    const message = {
      ...(extra ?? {}),
      event,
      instance: instanceName,
      data,
      server_url: serverUrl,
      date_time: dateTime,
      sender,
      apikey: apiKey,
    };

    if (configService.get<Websocket>('WEBSOCKET')?.GLOBAL_EVENTS) {
      this.socket.emit(event, message);

      if (logEnabled) {
        this.logger.log({ local: `${origin}.sendData-WebsocketGlobal`, ...message });
      }
    }

    try {
      const instance = await this.get(instanceName);

      if (!instance?.enabled) {
        return;
      }

      if (Array.isArray(instance?.events) && instance?.events.includes(configEv)) {
        this.socket.of(`/${instanceName}`).emit(event, message);

        if (logEnabled) {
          this.logger.log({ local: `${origin}.sendData-Websocket`, ...message });
        }
      }
    } catch (err) {
      if (logEnabled) {
        this.logger.log(err);
      }
    }
  }
}
