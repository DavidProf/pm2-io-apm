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

import { CoreTracer, HeaderGetter, HeaderSetter, Propagation, Span, SpanContext, SpanEventListener, logger } from '@opencensus/core'
import * as assert from 'assert'
import * as http from 'http'
import * as nock from 'nock'
import * as shimmer from 'shimmer'
import * as url from 'url'

import { plugin, HttpPlugin } from '../http'

function doNock (
    url: string, path: string, httpCode: number, respBody: string,
    times?: number) {
  const i = times || 1
  nock(url).get(path).times(i).reply(httpCode, respBody)
}

const httpRequest = {
  get: (options: http.ClientRequestArgs | string) => {
    return new Promise((resolve, reject) => {
      return http.get(options, resp => {
        let data = ''
        resp.on('data', chunk => {
          data += chunk
        })
        resp.on('end', () => {
          resolve(data)
        })
        resp.on('error', err => {
          reject(err)
        })
      })
    })
  }
}

const VERSION = process.versions.node

class DummyPropagation implements Propagation {
  extract (getter: HeaderGetter): SpanContext {
    return { traceId: 'dummy-trace-id', spanId: 'dummy-span-id' } as SpanContext
  }

  inject (setter: HeaderSetter, spanContext: SpanContext): void {
    setter.setHeader('x-dummy-trace-id', spanContext.traceId || 'undefined')
    setter.setHeader('x-dummy-span-id', spanContext.spanId || 'undefined')
  }

  generate (): SpanContext {
    return { traceId: 'dummy-trace-id', spanId: 'dummy-span-id' } as SpanContext
  }
}

class RootSpanVerifier implements SpanEventListener {
  endedRootSpans: Span[] = []

  onStartSpan (span: Span): void {
    return
  }
  onEndSpan (root: Span) {
    this.endedRootSpans.push(root)
  }
}

function assertSpanAttributes (
    span: Span, httpStatusCode: number, httpMethod: string, hostName: string,
    path: string, userAgent?: string) {
  assert.strictEqual(
      span.status.code, HttpPlugin.convertTraceStatus(httpStatusCode))
  assert.strictEqual(span.attributes[HttpPlugin.ATTRIBUTE_HTTP_HOST], hostName)
  assert.strictEqual(
      span.attributes[HttpPlugin.ATTRIBUTE_HTTP_METHOD], httpMethod)
  assert.strictEqual(span.attributes[HttpPlugin.ATTRIBUTE_HTTP_PATH], path)
  assert.strictEqual(span.attributes[HttpPlugin.ATTRIBUTE_HTTP_ROUTE], path)
  assert.strictEqual(
      span.attributes[HttpPlugin.ATTRIBUTE_HTTP_USER_AGENT], userAgent)
  assert.strictEqual(
      span.attributes[HttpPlugin.ATTRIBUTE_HTTP_STATUS_CODE],
      `${httpStatusCode}`)
}

describe('HttpPlugin', () => {
  const hostName = 'fake.service.io'
  const urlHost = `http://${hostName}`

  let server: http.Server
  let serverPort = 0
  const tracer = new CoreTracer()
  const rootSpanVerifier = new RootSpanVerifier()
  tracer.start({
    samplingRate: 1,
    logger: logger.logger(4),
    propagation: new DummyPropagation()
  })

  it('should return a plugin', () => {
    assert.ok(plugin instanceof HttpPlugin)
  })

  before(() => {
    plugin.enable(
        http, tracer, VERSION, {
          ignoreIncomingPaths: [
            '/ignored/string', /^\/ignored\/regexp/,
            (url: string) => url === '/ignored/function'
          ],
          ignoreOutgoingUrls: [
            `${urlHost}/ignored/string`,
            /^http:\/\/fake\.service\.io\/ignored\/regexp$/,
            (url: string) => url === `${urlHost}/ignored/function`
          ]
        },
        '')
    tracer.registerSpanEventListener(rootSpanVerifier)
    server = http.createServer((request, response) => {
      response.end('Test Server Response')
    })

    server.listen(serverPort)
    server.once('listening', () => {
      // to fix node 6 issue
      // disable-next-line to disable no-any check
      // tslint:disable-next-line
      serverPort = (server.address() as any).port
    })
    nock.disableNetConnect()
  })

  beforeEach(() => {
    rootSpanVerifier.endedRootSpans = []
    nock.cleanAll()
  })

  after(() => {
    server.close()
  })

  /** Should intercept outgoing requests */
  describe('patchOutgoingRequest()', () => {
    it('should create a rootSpan for GET requests as a client', async () => {
      const testPath = '/outgoing/rootSpan/1'
      doNock(urlHost, testPath, 200, 'Ok')
      assert.strictEqual(rootSpanVerifier.endedRootSpans.length, 0)
      await httpRequest.get(`${urlHost}${testPath}`).then((result) => {
        assert.strictEqual(result, 'Ok')
        assert.ok(
            rootSpanVerifier.endedRootSpans[0].name.indexOf('http-get') >= 0)
        assert.strictEqual(rootSpanVerifier.endedRootSpans.length, 1)

        const span = rootSpanVerifier.endedRootSpans[0]
        assertSpanAttributes(span, 200, 'GET', hostName, testPath, undefined)
      })
    })

    const httpErrorCodes = [400, 401, 403, 404, 429, 501, 503, 504, 500]

    for (let i = 0; i < httpErrorCodes.length; i++) {
      it(`should test rootSpan for GET requests with http error ${
             httpErrorCodes[i]}`,
         async () => {
           const testPath = '/outgoing/rootSpan/1'
           doNock(
               urlHost, testPath, httpErrorCodes[i],
               httpErrorCodes[i].toString())
           assert.strictEqual(rootSpanVerifier.endedRootSpans.length, 0)
           await httpRequest.get(`${urlHost}${testPath}`).then((result) => {
             assert.strictEqual(result, httpErrorCodes[i].toString())
             assert.ok(
                 rootSpanVerifier.endedRootSpans[0].name.indexOf('http-get') >=
                 0)
             assert.strictEqual(rootSpanVerifier.endedRootSpans.length, 1)
             const span = rootSpanVerifier.endedRootSpans[0]
             assertSpanAttributes(
                 span, httpErrorCodes[i], 'GET', hostName, testPath, undefined)
           })
         })
    }

    it('should create a child span for GET requests', () => {
      const testPath = '/outgoing/rootSpan/childs/1'
      doNock(urlHost, testPath, 200, 'Ok')
      const options = { name: 'TestRootSpan' }
      return tracer.startRootSpan(options, async (root: Span) => {
        await httpRequest.get(`${urlHost}${testPath}`).then((result) => {
          assert.ok(root.name.indexOf('TestRootSpan') >= 0)
          assert.strictEqual(root.spans.length, 1)
          assert.ok(root.spans[0].name.indexOf('http-get') >= 0)
          assert.strictEqual(root.traceId, root.spans[0].traceId)
          const span = root.spans[0]
          assertSpanAttributes(span, 200, 'GET', hostName, testPath, undefined)
        })
      })
    })

    for (let i = 0; i < httpErrorCodes.length; i++) {
      it(`should test a child spans for GET requests with http error ${
             httpErrorCodes[i]}`,
         () => {
           const testPath = '/outgoing/rootSpan/childs/1'
           doNock(
               urlHost, testPath, httpErrorCodes[i],
               httpErrorCodes[i].toString())
           const options = { name: 'TestRootSpan' }
           return tracer.startRootSpan(options, async (root: Span) => {
             await httpRequest.get(`${urlHost}${testPath}`).then((result) => {
               assert.ok(root.name.indexOf('TestRootSpan') >= 0)
               assert.strictEqual(root.spans.length, 1)
               assert.ok(root.spans[0].name.indexOf('http-get') >= 0)
               assert.strictEqual(root.traceId, root.spans[0].traceId)

               const span = root.spans[0]
               assertSpanAttributes(
                   span, httpErrorCodes[i], 'GET', hostName, testPath,
                   undefined)
             })
           })
         })
    }

    it('should create multiple child spans for GET requests', () => {
      const testPath = '/outgoing/rootSpan/childs'
      const num = 5
      doNock(urlHost, testPath, 200, 'Ok', num)
      const options = { name: 'TestRootSpan' }
      return tracer.startRootSpan(options, async (root: Span) => {
        assert.ok(root.name.indexOf('TestRootSpan') >= 0)
        for (let i = 0; i < num; i++) {
          await httpRequest.get(`${urlHost}${testPath}`).then((result) => {
            assert.strictEqual(root.spans.length, i + 1)
            assert.ok(root.spans[i].name.indexOf('http-get') >= 0)
            assert.strictEqual(root.traceId, root.spans[i].traceId)
          })
        }
        assert.strictEqual(rootSpanVerifier.endedRootSpans.length, 0)
        root.end()
        assert.strictEqual(rootSpanVerifier.endedRootSpans.length, 1)
      })
    })

    it('should not trace requests with \'x-opencensus-outgoing-request\' header',
       async () => {
         const testPath = '/outgoing/do-not-trace'
         doNock(urlHost, testPath, 200, 'Ok')

         const options = {
           host: hostName,
           path: testPath,
           headers: { 'x-opencensus-outgoing-request': 1 }
         }

         assert.strictEqual(rootSpanVerifier.endedRootSpans.length, 0)
         await httpRequest.get(options).then((result) => {
           assert.equal(result, 'Ok')
           assert.strictEqual(rootSpanVerifier.endedRootSpans.length, 0)
         })
       })

    for (const ignored of ['string', 'function', 'regexp']) {
      it(`should not trace ignored requests with type ${ignored}`, async () => {
        const testPath = `/ignored/${ignored}`
        doNock(urlHost, testPath, 200, 'Ok')

        const options = {
          host: hostName,
          path: testPath
        }

        assert.strictEqual(rootSpanVerifier.endedRootSpans.length, 0)
        await httpRequest.get(options)
        assert.strictEqual(rootSpanVerifier.endedRootSpans.length, 0)
      })
    }

    it('should create a rootSpan for GET requests and add propagation headers',
       async () => {
         nock.enableNetConnect()
         assert.strictEqual(rootSpanVerifier.endedRootSpans.length, 0)
         await httpRequest.get(`http://google.fr/`).then((result) => {
           assert.strictEqual(rootSpanVerifier.endedRootSpans.length, 1)
           assert.ok(
               rootSpanVerifier.endedRootSpans[0].name.indexOf('http-get') >= 0)

           const span = rootSpanVerifier.endedRootSpans[0]
           assertSpanAttributes(span, 301, 'GET', 'google.fr', '/', undefined)
         })
         nock.disableNetConnect()
       })

    it('should create a rootSpan for GET requests and add propagation headers', async () => {
      nock.enableNetConnect()
      assert.strictEqual(rootSpanVerifier.endedRootSpans.length, 0)
      const options = Object.assign({ headers: { Expect: '100-continue' } }, url.parse('http://google.fr/'))
      await httpRequest.get(options).then((result) => {
        assert.strictEqual(rootSpanVerifier.endedRootSpans.length, 1)
        assert.ok(
          rootSpanVerifier.endedRootSpans[0].name.indexOf('http-get') >= 0)

        const span = rootSpanVerifier.endedRootSpans[0]
        assertSpanAttributes(span, 301, 'GET', 'google.fr:80', '/', undefined)
      })
      nock.disableNetConnect()
    })
  })

  /** Should intercept incoming requests */
  describe('patchIncomingRequest()', () => {
    it('should create a root span for incoming requests', async () => {
      const testPath = '/incoming/rootSpan/'

      const options = {
        host: 'localhost',
        path: testPath,
        port: serverPort,
        headers: { 'User-Agent': 'Android' }
      }
      shimmer.unwrap(http, 'get')
      shimmer.unwrap(http, 'request')
      nock.enableNetConnect()

      assert.strictEqual(rootSpanVerifier.endedRootSpans.length, 0)

      await httpRequest.get(options).then((result) => {
        assert.ok(
            rootSpanVerifier.endedRootSpans[0].name.indexOf(testPath) >= 0)
        assert.strictEqual(rootSpanVerifier.endedRootSpans.length, 1)
        const span = rootSpanVerifier.endedRootSpans[0]
        assertSpanAttributes(
            span, 200, 'GET', 'localhost', testPath, 'Android')
      })
    })

    for (const ignored of ['string', 'function', 'regexp']) {
      it(`should not trace ignored requests with type ${ignored}`, async () => {
        const testPath = `/ignored/${ignored}`

        const options = {
          host: 'localhost',
          path: testPath,
          port: serverPort,
          headers: { 'User-Agent': 'Android' }
        }
        shimmer.unwrap(http, 'get')
        shimmer.unwrap(http, 'request')
        nock.enableNetConnect()

        assert.strictEqual(rootSpanVerifier.endedRootSpans.length, 0)
        await httpRequest.get(options)
        assert.strictEqual(rootSpanVerifier.endedRootSpans.length, 0)
      })
    }
  })

  // TODO: This tests relies on a specific order in which tests are executed.
  // Is it possible to make this test more isolated?

  /** Should not intercept incoming and outgoing requests */
  describe('applyUnpatch()', () => {
    it('should not create a root span for incoming requests', async () => {
      plugin.disable()
      const testPath = '/incoming/unpatch/'
      nock.enableNetConnect()

      const options = { host: 'localhost', path: testPath, port: serverPort }

      assert.strictEqual(rootSpanVerifier.endedRootSpans.length, 0)
      await httpRequest.get(options).then((result) => {
        assert.strictEqual(rootSpanVerifier.endedRootSpans.length, 0)
      })
    })
  })
})
