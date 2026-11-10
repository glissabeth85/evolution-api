import { InstanceDto } from '@api/dto/instance.dto';
import { prismaRepository } from '@api/server.module';
import { Auth, configService, Database } from '@config/env.config';
import { Logger } from '@config/logger.config';
import { UnauthorizedException } from '@exceptions';
import { isFetchInstancesRoute, safeCompare } from '@utils/requestPath';
import { NextFunction, Request, Response } from 'express';

const logger = new Logger('GUARD');

async function apikey(req: Request, _: Response, next: NextFunction) {
  const env = configService.get<Auth>('AUTHENTICATION').API_KEY;
  const key = req.get('apikey');
  const db = configService.get<Database>('DATABASE');

  if (!key) {
    throw new UnauthorizedException();
  }

  if (safeCompare(key, env.KEY)) {
    return next();
  }

  // Only the global key may reach routes without :instanceName (e.g. /instance/create),
  // except /instance/fetchInstances, which an instance token may call to read its own instance.
  const param = req.params as unknown as InstanceDto;

  try {
    if (param?.instanceName) {
      const instance = await prismaRepository.instance.findUnique({
        where: { name: param.instanceName },
      });
      if (instance && safeCompare(key, instance.token)) {
        return next();
      }
    } else {
      if (isFetchInstancesRoute(req) && db.SAVE_DATA.INSTANCE) {
        const instanceByKey = await prismaRepository.instance.findFirst({
          where: { token: key },
        });
        if (instanceByKey) {
          return next();
        }
      }
    }
  } catch (error) {
    logger.error(error);
  }

  throw new UnauthorizedException();
}

export const authGuard = { apikey };
