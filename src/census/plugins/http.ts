/**
 * Copyright 2018, OpenCensus Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License")
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { BasePlugin, Func, HeaderGetter, HeaderSetter, Span, TraceOptions, MessageEventType, SpanKind, CanonicalCode } from '@opencensus/core'
import * as httpModule from 'http'
import * as semver from 'semver'
import * as shimmer from 'shimmer'
import * as url from 'url'
import * as uuid from 'uuid'
import { kMiddlewareStack } from './express'

export type IgnoreMatcher<T> = string | RegExp | ((url: string, request: T) => boolean)

export type HttpPluginConfig = {
  /**
   * Ignore specific incoming request depending on their path
   */
  ignoreIncomingPaths: Array<IgnoreMatcher<httpModule.IncomingMessage>>
  /**
   * Ignore specific outgoing request depending on their url
   */
  ignoreOutgoingUrls: Array<IgnoreMatcher<httpModule.ClientRequest>>
  /**
   * Disable the creation of root span with http server
   * mainly used if net plugin is implemented
   */
  createSpanWithNet: boolean
}

export type HttpModule = typeof httpModule
export type RequestFunction = typeof httpModule.request

/** Http instrumentation plugin for Opencensus */
export class HttpPlugin extends BasePlugin {
  /**
   * Attributes Names according to Opencensus HTTP Specs
   * https://github.com/census-instrumentation/opencensus-specs/blob/master/trace/HTTP.md
   */
  static ATTRIBUTE_HTTP_HOST = 'http.host'
  static ATTRIBUTE_HTTP_METHOD = 'http.method'
  static ATTRIBUTE_HTTP_PATH = 'http.path'
  static ATTRIBUTE_HTTP_ROUTE = 'http.route'
  static ATTRIBUTE_HTTP_USER_AGENT = 'http.user_agent'
  static ATTRIBUTE_HTTP_STATUS_CODE = 'http.status_code'
  // NOT ON OFFICIAL SPEC
  static ATTRIBUTE_HTTP_ERROR_NAME = 'http.error_name'
  static ATTRIBUTE_HTTP_ERROR_MESSAGE = 'http.error_message'

  protected options: HttpPluginConfig

  /** Constructs a new HttpPlugin instance. */
  constructor (moduleName: string) {
    super(moduleName)
  }

  /**
   * Patches HTTP incoming and outcoming request functions.
   */
  protected applyPatch () {
    this.logger.debug('applying patch to %s@%s', this.moduleName, this.version)

    shimmer.wrap(
        this.moduleExports, 'request', this.getPatchOutgoingRequestFunction())

    // In Node 8, http.get calls a private request method, therefore we patch it
    // here too.
    if (semver.satisfies(this.version, '>=8.0.0')) {
      shimmer.wrap(
          this.moduleExports, 'get', () => {
            // Re-implement http.get. This needs to be done (instead of using
            // makeRequestTrace to patch it) because we need to set the trace
            // context header before the returned ClientRequest is ended.
            // The Node.js docs state that the only differences between request and
            // get are that (1) get defaults to the HTTP GET method and (2) the
            // returned request object is ended immediately.
            // The former is already true (at least in supported Node versions up to
            // v9), so we simply follow the latter.
            // Ref:
            // https://nodejs.org/dist/latest/docs/api/http.html#http_http_get_options_callback
            // https://github.com/googleapis/cloud-trace-nodejs/blob/master/src/plugins/plugin-http.ts#L198
            return function getTrace (options, callback) {
              const req = httpModule.request(options, callback)
              req.end()
              return req
            }
          })
    }

    if (this.moduleExports && this.moduleExports.Server &&
        this.moduleExports.Server.prototype) {
      shimmer.wrap(
          this.moduleExports.Server.prototype, 'emit',
          this.getPatchIncomingRequestFunction())
    } else {
      this.logger.error(
          'Could not apply patch to %s.emit. Interface is not as expected.',
          this.moduleName)
    }

    return this.moduleExports
  }

  /** Unpatches all HTTP patched function. */
  protected applyUnpatch (): void {
    shimmer.unwrap(this.moduleExports, 'request')
    if (semver.satisfies(this.version, '>=8.0.0')) {
      shimmer.unwrap(this.moduleExports, 'get')
    }
    if (this.moduleExports && this.moduleExports.Server &&
        this.moduleExports.Server.prototype) {
      shimmer.unwrap(this.moduleExports.Server.prototype, 'emit')
    }
  }

  /**
   * Check whether the given request is ignored by configuration
   * @param url URL of request
   * @param request Request to inspect
   * @param list List of ignore patterns
   */
  protected isIgnored<T> (
      url: string, request: T, list: Array<IgnoreMatcher<T>>): boolean {
    if (!list) {
      // No ignored urls - trace everything
      return false
    }

    for (const pattern of list) {
      if (this.isSatisfyPattern(url, request, pattern)) {
        return true
      }
    }

    return false
  }

  /**
   * Check whether the given request match pattern
   * @param url URL of request
   * @param request Request to inspect
   * @param pattern Match pattern
   */
  protected isSatisfyPattern<T> (
      url: string, request: T, pattern: IgnoreMatcher<T>): boolean {
    if (typeof pattern === 'string') {
      return pattern === url
    } else if (pattern instanceof RegExp) {
      return pattern.test(url)
    } else if (typeof pattern === 'function') {
      return pattern(url, request)
    } else {
      throw new TypeError('Pattern is in unsupported datatype')
    }
  }

  /**
   * Creates spans for incoming requests, restoring spans' context if applied.
   */
  protected getPatchIncomingRequestFunction () {
    return (original: (event: string) => boolean) => {
      const plugin = this
      // This function's signature is that of an event listener, which can have
      // any number of variable-type arguments.
      // tslint:disable-next-line:no-any
      return function incomingRequest (event: string, ...args: any[]): boolean {
        // Only traces request events
        if (event !== 'request') {
          return original.apply(this, arguments)
        }

        const request: httpModule.IncomingMessage = args[0]
        const response: httpModule.ServerResponse = args[1]
        // @ts-ignore
        const path = url.parse(request.url).pathname

        plugin.logger.debug('%s plugin incomingRequest', plugin.moduleName)

        if (plugin.isIgnored(path, request, plugin.options.ignoreIncomingPaths)) {
          return original.apply(this, arguments)
        }

        const propagation = plugin.tracer.propagation
        const headers = request.headers
        const getter: HeaderGetter = {
          getHeader (name: string) {
            return headers[name]
          }
        }

        const context = propagation ? propagation.extract(getter) : null
        const traceOptions: TraceOptions = {
          name: path,
          kind: SpanKind.SERVER,
          spanContext: context !== null ? context : undefined
        }

        return plugin.createSpan(traceOptions, rootSpan => {
          if (!rootSpan) return original.apply(this, arguments)

          plugin.tracer.wrapEmitter(request)
          plugin.tracer.wrapEmitter(response)

          // Wraps end (inspired by:
          // https://github.com/GoogleCloudPlatform/cloud-trace-nodejs/blob/master/src/plugins/plugin-connect.ts#L75)
          const originalEnd = response.end

          response.end = function (this: httpModule.ServerResponse) {
            response.end = originalEnd
            const returned = response.end.apply(this, arguments)

            const requestUrl = url.parse(request.url || 'localhost')
            const host = headers.host || 'localhost'
            const userAgent =
                (headers['user-agent'] || headers['User-Agent']) as string

            rootSpan.addAttribute(
                HttpPlugin.ATTRIBUTE_HTTP_HOST,
                host.replace(/^(.*)(\:[0-9]{1,5})/, '$1'))
            rootSpan.addAttribute(
                HttpPlugin.ATTRIBUTE_HTTP_METHOD, request.method || 'GET')
            rootSpan.addAttribute(
                HttpPlugin.ATTRIBUTE_HTTP_PATH, `${requestUrl.pathname}`)
            let route = `${requestUrl.path}`
            const middlewareStack: string[] = request[kMiddlewareStack]
            if (middlewareStack) {
              route = middlewareStack
                .filter(path => path !== '/')
                .map(path => {
                  return path[0] === '/' ? path : '/' + path
                }).join('')
            }
            rootSpan.addAttribute(HttpPlugin.ATTRIBUTE_HTTP_ROUTE, route)
            rootSpan.addAttribute(
                HttpPlugin.ATTRIBUTE_HTTP_USER_AGENT, userAgent)

            rootSpan.addAttribute(
                HttpPlugin.ATTRIBUTE_HTTP_STATUS_CODE,
                response.statusCode.toString())

            rootSpan.setStatus(HttpPlugin.convertTraceStatus(response.statusCode))

            // Message Event ID is not defined
            rootSpan.addMessageEvent(
                MessageEventType.RECEIVED, uuid.v4().split('-').join(''))

            rootSpan.end()
            return returned
          }

          return original.apply(this, arguments)
        })
      }
    }
  }

  /**
   * Creates spans for outgoing requests, sending spans' context for distributed
   * tracing.
   */
  protected getPatchOutgoingRequestFunction () {
    return (original: Func<httpModule.ClientRequest>): Func<
               httpModule.ClientRequest> => {
      const plugin = this
      const kind = plugin.moduleName === 'https' ? 'HTTPS' : 'HTTP'
      return function outgoingRequest (
                 options: httpModule.RequestOptions | string,
                 callback): httpModule.ClientRequest {
        if (!options) {
          return original.apply(this, arguments)
        }

        // Makes sure the url is an url object
        let pathname = ''
        let method = 'GET'
        let origin = ''
        if (typeof (options) === 'string') {
          const parsedUrl = url.parse(options)
          options = parsedUrl
          pathname = parsedUrl.pathname || '/'
          origin = `${parsedUrl.protocol || 'http:'}//${parsedUrl.host}`
        } else {
          // Do not trace ourselves
          if (options.headers &&
              options.headers['x-opencensus-outgoing-request']) {
            plugin.logger.debug(
                'header with "x-opencensus-outgoing-request" - do not trace')
            return original.apply(this, arguments)
          }

          try {
            pathname = (options as url.URL).pathname || ''
            if (pathname.length === 0 && typeof options.path === 'string') {
              pathname = url.parse(options.path).pathname || ''
            }
            method = options.method || 'GET'
            origin = `${options.protocol || 'http:'}//${options.host}`
          } catch (e) {
            return original.apply(this, arguments)
          }
        }

        const request: httpModule.ClientRequest =
            original.apply(this, arguments)

        if (plugin.isIgnored(origin + pathname, request, plugin.options.ignoreOutgoingUrls)) {
          return request
        }

        plugin.tracer.wrapEmitter(request)

        plugin.logger.debug('%s plugin outgoingRequest', plugin.moduleName)
        const traceOptions = {
          name: `${kind.toLowerCase()}-${(method || 'GET').toLowerCase()}`,
          kind: SpanKind.CLIENT
        }
        // Checks if this outgoing request is part of an operation by checking
        // if there is a current root span, if so, we create a child span. In
        // case there is no root span, this means that the outgoing request is
        // the first operation, therefore we create a root span.
        if (!plugin.tracer.currentRootSpan) {
          plugin.logger.debug('outgoingRequest starting a root span')
          return plugin.tracer.startRootSpan(
              traceOptions,
              plugin.getMakeRequestTraceFunction(request, options, plugin))
        } else {
          plugin.logger.debug('outgoingRequest starting a child span')
          const span = plugin.tracer.startChildSpan({
            name: traceOptions.name,
            kind: traceOptions.kind
          })
          return (plugin.getMakeRequestTraceFunction(request, options, plugin))(
              span)
        }
      }
    }
  }

  /**
   * Injects span's context to header for distributed tracing and finshes the
   * span when the response is finished.
   * @param original The original patched function.
   * @param options The arguments to the original function.
   */
  private getMakeRequestTraceFunction (
      request: httpModule.ClientRequest, options: httpModule.RequestOptions,
      plugin: HttpPlugin): Func<httpModule.ClientRequest> {
    return (span: Span): httpModule.ClientRequest => {
      plugin.logger.debug('makeRequestTrace')

      if (!span) {
        plugin.logger.debug('makeRequestTrace span is null')
        return request
      }

      const setter: HeaderSetter = {
        setHeader (name: string, value: string) {
          // If outgoing request headers contain the "Expect" header, the returned
          // ClientRequest will throw an error if any new headers are added. For this
          // reason, only in this scenario, we opt to clone the options object to
          // inject the trace context header instead of using ClientRequest#setHeader.
          // (We don't do this generally because cloning the options object is an
          // expensive operation.)
          if (plugin.hasExpectHeader(options) && options.headers) {
            // @ts-ignore
            if (options.__cloned !== true) {
              options = Object.assign({}, options) as httpModule.ClientRequestArgs
              options.headers = Object.assign({}, options.headers)
              // @ts-ignore
              options.__cloned = true
            }
            // Inject the trace context header.
            options.headers[name] = value
          } else {
            request.setHeader(name, value)
          }
        }
      }

      const propagation = plugin.tracer.propagation
      if (propagation) {
        propagation.inject(setter, span.spanContext)
      }

      request.on('response', (response: httpModule.IncomingMessage) => {
        plugin.tracer.wrapEmitter(response)
        plugin.logger.debug('outgoingRequest on response()')

        response.on('end', () => {
          plugin.logger.debug('outgoingRequest on end()')
          const method = response.method ? response.method : 'GET'
          const headers = options.headers
          const userAgent =
              headers ? (headers['user-agent'] || headers['User-Agent']) : null
          if (options.host || options.hostname) {
            const value = options.host || options.hostname
            span.addAttribute(HttpPlugin.ATTRIBUTE_HTTP_HOST, `${value}`)
          }
          span.addAttribute(HttpPlugin.ATTRIBUTE_HTTP_METHOD, method)
          span.addAttribute(HttpPlugin.ATTRIBUTE_HTTP_PATH, `${options.path}`)
          span.addAttribute(HttpPlugin.ATTRIBUTE_HTTP_ROUTE, `${options.path}`)
          if (userAgent) {
            span.addAttribute(
                HttpPlugin.ATTRIBUTE_HTTP_USER_AGENT, userAgent.toString())
          }
          span.addAttribute(HttpPlugin.ATTRIBUTE_HTTP_STATUS_CODE, `${response.statusCode}`)
          span.setStatus(HttpPlugin.convertTraceStatus(response.statusCode || 0))

          // Message Event ID is not defined
          span.addMessageEvent(MessageEventType.SENT, uuid.v4().split('-').join(''))

          span.end()
        })

        response.on('error', error => {
          span.addAttribute(HttpPlugin.ATTRIBUTE_HTTP_ERROR_NAME, error.name)
          span.addAttribute(
              HttpPlugin.ATTRIBUTE_HTTP_ERROR_MESSAGE, error.message)
          span.setStatus(CanonicalCode.UNKNOWN)
          span.end()
        })
      })

      request.on('error', error => {
        span.addAttribute(HttpPlugin.ATTRIBUTE_HTTP_ERROR_NAME, error.name)
        span.addAttribute(
            HttpPlugin.ATTRIBUTE_HTTP_ERROR_MESSAGE, error.message)
        span.setStatus(CanonicalCode.UNKNOWN)
        span.end()
      })

      plugin.logger.debug('makeRequestTrace return request')
      return request
    }
  }

  private createSpan<T> (options: TraceOptions, fn: (span: Span) => T): T {
    const forceChildspan = this.options.createSpanWithNet === true
    if (forceChildspan) {
      const span = this.tracer.startChildSpan({ name: options.name, kind: options.kind })
      return fn(span)
    } else {
      return this.tracer.startRootSpan(options, fn)
    }
  }

  /**
   * Converts an HTTP status code to an OpenCensus Trace status code.
   * @param statusCode The HTTP status code to convert.
   */
  static convertTraceStatus (statusCode: number): number {
    if (statusCode < 200 || statusCode > 504) {
      return TraceStatusCodes.UNKNOWN
    } else if (statusCode >= 200 && statusCode < 400) {
      return TraceStatusCodes.OK
    } else {
      switch (statusCode) {
        case (400):
          return TraceStatusCodes.INVALID_ARGUMENT
        case (504):
          return TraceStatusCodes.DEADLINE_EXCEEDED
        case (404):
          return TraceStatusCodes.NOT_FOUND
        case (403):
          return TraceStatusCodes.PERMISSION_DENIED
        case (401):
          return TraceStatusCodes.UNAUTHENTICATED
        case (429):
          return TraceStatusCodes.RESOURCE_EXHAUSTED
        case (501):
          return TraceStatusCodes.UNIMPLEMENTED
        case (503):
          return TraceStatusCodes.UNAVAILABLE
        default:
          return TraceStatusCodes.UNKNOWN
      }
    }
  }

  /**
   * Returns whether the Expect header is on the given options object.
   * @param options Options for http.request.
   */
  hasExpectHeader (options: httpModule.ClientRequestArgs | url.URL): boolean {
    return !!(
        (options as httpModule.ClientRequestArgs).headers &&
        (options as httpModule.ClientRequestArgs).headers!.Expect)
  }
}

/**
 * An enumeration of OpenCensus Trace status codes.
 */
export enum TraceStatusCodes {
  UNKNOWN = 2,
  OK = 0,
  INVALID_ARGUMENT = 3,
  DEADLINE_EXCEEDED = 4,
  NOT_FOUND = 5,
  PERMISSION_DENIED = 7,
  UNAUTHENTICATED = 16,
  RESOURCE_EXHAUSTED = 8,
  UNIMPLEMENTED = 12,
  UNAVAILABLE = 14
}

export const plugin = new HttpPlugin('http')
