process.env.NODE_ENV='test'

import * as pmx from '../../../src'
pmx.init({
  tracing: {
    enabled: true,
    samplingRate: 1
  }
})

// @ts-ignore added in ci only
import * as express from 'express'
import { SpanKind } from '@opencensus/core'
import { AddressInfo } from 'net'
const app = express()

const http = require('http')
const https = require('https')

// test http outbound
let timer

app.get('/', function (req, res) {
  http.get('http://localhost:' + (server.address() as AddressInfo).port + '/toto', (_) => {
    const tracer = pmx.getTracer()
    if (tracer === undefined) throw new Error('tracer undefined')
    const customSpan = tracer.startChildSpan({ name: 'customspan', kind: SpanKind.CLIENT })
    customSpan.addAttribute('test', true)
    setTimeout(_ => {
      customSpan.end()
      res.send('home')
    }, 100)
  })
})

app.get('/toto', function (req, res) {
  res.send('toto')
})

const server = app.listen(3001, function () {
  console.log('App listening')
  timer = setInterval(function () {
    console.log('Running query')
    http.get('http://localhost:' + (server.address() as AddressInfo).port, (_) => {
      return
    })
    https.get('https://google.fr')
  }, 500)
})

process.on('SIGINT', function () {
  clearInterval(timer)
  server.close()
})
