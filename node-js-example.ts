import {readdirSync, lstatSync} from 'fs';
import * as changeCase from 'change-case';
import {controllerFolderPath as defaultControllerFolderPath, apiPath as defaultApiPath} from 'config';
import {variableType} from './globalConsts';
import {validationResult} from 'express-validator/check';
import {MiddlewareService} from '@services/MiddlewareService';
import {ValidationError} from '../errors/ValidationError';
import {Logger} from './Logger';
import {Router} from 'express-serve-static-core';

import {join} from 'path';

export class RouteUtil {
  private static predefinedRoutes: object = {
    list: 'get',
    create: 'post',
    update: 'patch',
    destroy: 'delete',
    show: 'get',
  };

  private static acceptedMethods: string[] = ['get', 'post', 'patch', 'put', 'delete'];

  private static middlewaresMapped: object = {};

  private static routeWithParams: string[] = ['update', 'destroy', 'show'];

  private static ignoredKeys: string[] = ['routeMiddlewares', 'routeValidation', 'routeParams'];

  private static isFile(source) {
    return lstatSync(source).isFile();
  }

  private static resultSend(res, result) {
    if (result && result.hasOwnProperty('password')) delete result.password;
    if (res.statusCode === 200) return res.json(result);
    return res;
  }

  private static errorChecker(req, res, next) {
    const [error] = validationResult(req).array() as any;
    if (!error) return next();

    throw new ValidationError(error.param + ' ' + error.msg);
  }

  private static addValidation(middlewares, methodName, controller) {
    if (controller.validation && controller.validation[methodName] &&
      Array.isArray(controller.validation[methodName]) && controller.validation[methodName].length) {
      middlewares.push(controller.validation[methodName]);
      middlewares.push(RouteUtil.errorChecker);
    }

    return middlewares;
  }

  private static getDefaultRoutePath(controllerPath, methodName, paramName) {
    return !RouteUtil.routeWithParams.includes(methodName) ? controllerPath : `${controllerPath}/:${paramName}`;
  }

  private static getCustomRoutePath(controller, controllerPath, methodName, requestType) {
    controllerPath = `${controllerPath}/${changeCase.snakeCase(methodName).replace(`${requestType}_`, '')}`;
    if (controller.params &&
      controller.params[methodName] &&
      Array.isArray(controller.params[methodName]) &&
      controller.params[methodName].length
    ) return `${controllerPath}/:${controller.params[methodName].join('/:')}`;

    return controllerPath;
  }

  private static getMiddlewaresMapped() {
    for (const name of Object.getOwnPropertyNames(MiddlewareService)) {
      const method = MiddlewareService[name];
      if (!(method instanceof Function) || method === MiddlewareService) continue;
      RouteUtil.middlewaresMapped[name] = method;
    }
  }

  private static getRouteMiddlewares(methodName, controller) {
    const middlewares: any[] = [];
    if (controller.middlewares &&
      controller.middlewares[methodName] &&
      Array.isArray(controller.middlewares[methodName]) &&
      controller.middlewares[methodName].length
    ) {
      for (const middlewareItem of controller.middlewares[methodName]) {
        if (typeof middlewareItem === variableType.FUNCTION) {
          middlewares.push(middlewareItem);
          continue;
        }

        if (typeof middlewareItem === variableType.STRING) {
          if (RouteUtil.middlewaresMapped[middlewareItem] && typeof RouteUtil.middlewaresMapped[middlewareItem] === variableType.FUNCTION) {
            middlewares.push(RouteUtil.middlewaresMapped[middlewareItem]);
          } else {
            Logger.warning(`${RouteUtil.constructor.name}: middleware '${middlewareItem}' not found in MiddlewareService`);
          }
        }
      }
    }

    return RouteUtil.addValidation(middlewares, methodName, controller);
  }

  private static buildDefaultRoute(router: Router, controller: any, apiPath: string, methodName: string, paramName: string) {
    const requestType = RouteUtil.predefinedRoutes[methodName];
    const path = RouteUtil.getDefaultRoutePath(apiPath, methodName, paramName);

    router[requestType](
      path,
      ...RouteUtil.getRouteMiddlewares(methodName, controller),
      RouteUtil.getControllerMethod(controller, methodName),
    );

    console.log(`${requestType.toUpperCase()} ${path}`);
  }

  private static getControllerMethod(controller, methodName) {
    return async (req, res, next) => {
      try {
        const result = await controller[methodName](req, res, next);
        if (!result && result !== 0) return RouteUtil.resultSend(res, 'ok');

        return RouteUtil.resultSend(res, result);
      } catch (e) {
        next(e);
      }
    };
  }

  private static buildCustomRoute(router, controller, controllerPath, methodName) {
    const requestType = RouteUtil.getCustomRouteRequestType(methodName);
    const path = RouteUtil.getCustomRoutePath(controller, controllerPath, methodName, requestType);

    router[requestType](
      path,
      ...RouteUtil.getRouteMiddlewares(methodName, controller),
      RouteUtil.getControllerMethod(controller, methodName),
    );

    console.log(`${requestType.toUpperCase()} ${path}`);
  }

  private static getCustomRouteRequestType(methodName: string) {
    return changeCase.snakeCase(methodName).split('_')[0];
  }

  private static checkIsRouteMethod(methodName) {
    return RouteUtil.acceptedMethods.indexOf(RouteUtil.getCustomRouteRequestType(methodName)) !== -1;
  }

  private static buildController(folderName: string, controllerPath: string, router: Router, apiPath: string) {
    const className = `${changeCase.upperCaseFirst(changeCase.camelCase(folderName))}Controller`;
    let controllerData;

    apiPath = `${apiPath}/${folderName}`;
    try {
      controllerData = require(`${controllerPath}/${className}.ts`);
    } catch (e) {
      return RouteUtil.buildSubFolderRoutes(controllerPath, router, apiPath);
    }

    const controller = new controllerData[className]();

    const paramName = `${changeCase.camelCase(folderName)}Id`;

    const methodNames = Object.keys(controller)
      .filter(methodName => (
        !RouteUtil.ignoredKeys.includes(methodName) && typeof controller[methodName] === variableType.FUNCTION),
      );

    for (const methodName of methodNames) {
      if (RouteUtil.checkIsRouteMethod(methodName)) {
        RouteUtil.buildCustomRoute(router, controller, apiPath, methodName);
      }
    }

    for (const methodName of methodNames) {
      if (RouteUtil.predefinedRoutes[methodName]) {
        RouteUtil.buildDefaultRoute(router, controller, apiPath, methodName, paramName);
      }
    }
  }

  private static buildSubFolderRoutes(controllerFolderPath: string, router: Router, apiPath: string): void {
    const controllerFolders = readdirSync(controllerFolderPath);

    for (const folderName of controllerFolders) {
      const controllerPath = join(controllerFolderPath, folderName);
      if (RouteUtil.isFile(controllerPath)) continue;

      RouteUtil.buildController(folderName, controllerPath, router, apiPath);
    }
  }

  public static build(router: Router) {
    console.log('Building routes');

    RouteUtil.getMiddlewaresMapped();
    RouteUtil.buildSubFolderRoutes(defaultControllerFolderPath, router, defaultApiPath);
  }
}
