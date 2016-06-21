/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

'use strict'

const electron = require('electron')
const app = electron.app
const fs = require('fs')
const moment = require('moment')
const path = require('path')
var random = require('random-lib')
const underscore = require('underscore')
const messages = require('../js/constants/messages')
const request = require('../js/lib/request')

// TBD: remove this post alpha
const alphaPath = path.join(app.getPath('userData'), 'ledger-alpha.json')

// TBD: remove these post beta
const logPath = path.join(app.getPath('userData'), 'ledger-log.json')
const publisherPath = path.join(app.getPath('userData'), 'ledger-publisher.json')

// TBD: move this into appStore.getState().get(‘ledger.client’)
const statePath = path.join(app.getPath('userData'), 'ledger-state.json')

// TBD: move this into appStore.getState().get(‘publishers.synopsis’)
const synopsisPath = path.join(app.getPath('userData'), 'ledger-synopsis.json')

var msecs = { day: 24 * 60 * 60 * 1000,
              hour: 60 * 60 * 1000,
              minute: 60 * 1000,
              second: 1000
          }

var client
var topPublishersN = 25

var LedgerPublisher
var synopsis
var locations
var publishers

var currentLocation
var currentTS

var returnValue = {
  enabled: false,
  synopsis: null,
  statusText: null,
  notifyP: false,

  _internal: {}
}

module.exports.init = () => {
  try { init() } catch (ex) { console.log('initialization failed: ' + ex.toString() + '\n' + ex.stack) }
}

var init = () => {
  var LedgerClient

  var makeClient = (path, cb) => {
    fs.readFile(path, (err, data) => {
      var state

      if (err) return console.log('read error: ' + err.toString())

      try {
        state = JSON.parse(data)
        console.log('\nstarting up ledger client integration')
        cb(null, state)
      } catch (ex) {
        console.log(path + (state ? ' ledger' : ' parse') + ' error: ' + ex.toString())
        cb(ex)
      }
    })
  }

  LedgerClient = require('ledger-client')
  fs.access(statePath, fs.FF_OK, (err) => {
    if (!err) {
      console.log('found ' + statePath)

      makeClient(statePath, (err, state) => {
        var info

        if (err) return

        returnValue.enabled = true
        returnValue._internal.reconcileStamp = state.reconcileStamp
        info = state.paymentInfo
        if (info) {
          returnValue._internal.paymentInfo = info

          setTimeout(() => { cacheReturnValue() }, 5 * msecs.second)

          returnValue._internal.triggerID = setTimeout(() => { triggerNotice() },
                                                       state.options.debugP ? (5 * msecs.second) : 5 * msecs.minute)
        }
        client = LedgerClient(state.personaId, state.options, state)
        if (client.sync(callback) === true) {
          run(random.randomInt({ min: 0, max: (state.options.debugP ? 5 * msecs.second : 10 * msecs.minute) }))
        }
      })
      return
    }
    if (err.code !== 'ENOENT') console.log('statePath read error: ' + err.toString())

    fs.access(alphaPath, fs.FF_OK, (err) => {
      if (err) {
        if (err.code !== 'ENOENT') console.log('accessPath read error: ' + err.toString())
        return
      }

      console.log('found ' + alphaPath)
      makeClient(alphaPath, (err, alpha) => {
        if (err) return

        client = LedgerClient(alpha.client.personaId, alpha.client.options, null)
        if (client.sync(callback) === true) run(random.randomInt({ min: 0, max: 10 * msecs.minute }))
      })
    })
  })

  LedgerPublisher = require('ledger-publisher')
  fs.readFile(synopsisPath, (err, data) => {
    console.log('\nstarting up ledger publisher integration')
    synopsis = new (LedgerPublisher.Synopsis)()

    if (err) {
      if (err.code !== 'ENOENT') console.log('synopsisPath read error: ' + err.toString())
      return
    }

    try {
      synopsis = new (LedgerPublisher.Synopsis)(data)
    } catch (ex) {
      console.log('synopsisPath parse error: ' + ex.toString())
    }

    fs.readFile(publisherPath, (err, data) => {
      locations = {}
      publishers = {}

      if (err) {
        if (err.code !== 'ENOENT') console.log('publisherPath read error: ' + err.toString())
        return
      }

      try {
        publishers = JSON.parse(data)
        underscore.keys(publishers).sort().forEach((publisher) => {
          var entries = publishers[publisher]

          entries.forEach((entry) => { locations[entry.location] = true })
        })
      } catch (ex) {
        console.log('publishersPath parse error: ' + ex.toString())
      }
    })
  })
}

var syncP = {}
var syncWriter = (path, obj, options, cb) => {
  if (syncP[path]) return
  syncP[path] = true

  if (typeof options === 'function') {
    cb = options
    options = null
  }
  options = underscore.defaults(options || {}, { encoding: 'utf8', mode: parseInt('644', 8) })

  fs.writeFile(path, JSON.stringify(obj, null, 2), options, (err) => {
    syncP[path] = false

    if (err) console.log('write error: ' + err.toString())

    cb(err)
  })
}

var logs = []
var callback = (err, result, delayTime) => {
  var i, then
  var entries = client.report()
  var now = underscore.now()

  console.log('\nledger client callback: errP=' + (!!err) + ' resultP=' + (!!result) + ' delayTime=' + delayTime)

  if (err) return console.log('ledger client error: ' + err.toString() + '\n' + err.stack)

  returnValue.enabled = true

  if (entries) {
    then = now - (7 * msecs.day)
    logs = logs.concat(entries)

    for (i = 0; i < logs.length; i++) if (logs[i].when > then) break
    if ((i !== 0) && (i !== logs.length)) logs = logs.slice(i)
    if (result) entries.push({ who: 'callback', what: result, when: underscore.now() })

    syncWriter(logPath, entries, { flag: 'a' }, () => {})
  }

  if (!result) return run(delayTime)

  returnValue._internal.reconcileStamp = result.reconcileStamp
  if (result.wallet) {
    if (result.paymentInfo) {
      returnValue._internal.paymentInfo = result.paymentInfo
      cacheReturnValue()

      if (!returnValue._internal.triggerID) {
        returnValue._internal.triggerID = setTimeout(() => { triggerNotice() }, 5 * msecs.minute)
      }
    }
    returnValue.statusText = 'Initialized.'
  } else if (result.persona) {
    if (result.properties) {
      returnValue.statusText = 'Anonymously ' + (result.options.wallet ? 'registered' : 'created') + ' wallet.'
    } else {
      returnValue.statusText = 'Preparing to anonymously ' + (result.options.wallet ? 'register' : 'create') + ' wallet.'
    }
  } else {
    returnValue.statusText = 'Initializing'
  }

  syncWriter(statePath, result, () => { run(delayTime) })
}

var run = (delayTime) => {
  console.log('\nledger client run: delayTime=' + delayTime)

  if (delayTime === 0) {
    delayTime = client.timeUntilReconcile()
    if (delayTime === false) delayTime = 0
  }
  if (delayTime > 0) return setTimeout(() => { if (client.sync(callback) === true) return run(0) }, delayTime)

  if (client.isReadyToReconcile()) return client.reconcile(synopsis.topN(topPublishersN), callback)

  console.log('\nwhat? wait.')
}

const faviconPNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAYAAADgdz34AAAAGXRFWHRTb2Z0d2FyZQBBZG9iZSBJbWFnZVJlYWR5ccllPAAAA0xpVFh0WE1MOmNvbS5hZG9iZS54bXAAAAAAADw/eHBhY2tldCBiZWdpbj0i77u/IiBpZD0iVzVNME1wQ2VoaUh6cmVTek5UY3prYzlkIj8+IDx4OnhtcG1ldGEgeG1sbnM6eD0iYWRvYmU6bnM6bWV0YS8iIHg6eG1wdGs9IkFkb2JlIFhNUCBDb3JlIDUuNi1jMTExIDc5LjE1ODMyNSwgMjAxNS8wOS8xMC0wMToxMDoyMCAgICAgICAgIj4gPHJkZjpSREYgeG1sbnM6cmRmPSJodHRwOi8vd3d3LnczLm9yZy8xOTk5LzAyLzIyLXJkZi1zeW50YXgtbnMjIj4gPHJkZjpEZXNjcmlwdGlvbiByZGY6YWJvdXQ9IiIgeG1sbnM6eG1wTU09Imh0dHA6Ly9ucy5hZG9iZS5jb20veGFwLzEuMC9tbS8iIHhtbG5zOnN0UmVmPSJodHRwOi8vbnMuYWRvYmUuY29tL3hhcC8xLjAvc1R5cGUvUmVzb3VyY2VSZWYjIiB4bWxuczp4bXA9Imh0dHA6Ly9ucy5hZG9iZS5jb20veGFwLzEuMC8iIHhtcE1NOkRvY3VtZW50SUQ9InhtcC5kaWQ6MUNFNTM2NTcxQzQyMTFFNjhEODk5OTY1MzJCOUU0QjEiIHhtcE1NOkluc3RhbmNlSUQ9InhtcC5paWQ6MUNFNTM2NTYxQzQyMTFFNjhEODk5OTY1MzJCOUU0QjEiIHhtcDpDcmVhdG9yVG9vbD0iQWRvYmUgUGhvdG9zaG9wIENDIDIwMTUgKE1hY2ludG9zaCkiPiA8eG1wTU06RGVyaXZlZEZyb20gc3RSZWY6aW5zdGFuY2VJRD0iYWRvYmU6ZG9jaWQ6cGhvdG9zaG9wOjUxZDUzZDBmLTYzOWMtMTE3OS04Yjk3LTg3Y2M5YTUyOWRmMSIgc3RSZWY6ZG9jdW1lbnRJRD0iYWRvYmU6ZG9jaWQ6cGhvdG9zaG9wOjUxZDUzZDBmLTYzOWMtMTE3OS04Yjk3LTg3Y2M5YTUyOWRmMSIvPiA8L3JkZjpEZXNjcmlwdGlvbj4gPC9yZGY6UkRGPiA8L3g6eG1wbWV0YT4gPD94cGFja2V0IGVuZD0iciI/PmF3+n4AAAAoSURBVHja7M1BAQAABAQw9O98SvDbCqyT1KepZwKBQCAQCAQ3VoABAAu6Ay00hnjWAAAAAElFTkSuQmCC'

const coinbasePNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAJYAAACWCAYAAAA8AXHiAAAAGXRFWHRTb2Z0d2FyZQBBZG9iZSBJbWFnZVJlYWR5ccllPAAAA+1pVFh0WE1MOmNvbS5hZG9iZS54bXAAAAAAADw/eHBhY2tldCBiZWdpbj0i77u/IiBpZD0iVzVNME1wQ2VoaUh6cmVTek5UY3prYzlkIj8+IDx4OnhtcG1ldGEgeG1sbnM6eD0iYWRvYmU6bnM6bWV0YS8iIHg6eG1wdGs9IkFkb2JlIFhNUCBDb3JlIDUuNi1jMDE0IDc5LjE1Njc5NywgMjAxNC8wOC8yMC0wOTo1MzowMiAgICAgICAgIj4gPHJkZjpSREYgeG1sbnM6cmRmPSJodHRwOi8vd3d3LnczLm9yZy8xOTk5LzAyLzIyLXJkZi1zeW50YXgtbnMjIj4gPHJkZjpEZXNjcmlwdGlvbiByZGY6YWJvdXQ9IiIgeG1sbnM6eG1wPSJodHRwOi8vbnMuYWRvYmUuY29tL3hhcC8xLjAvIiB4bWxuczpkYz0iaHR0cDovL3B1cmwub3JnL2RjL2VsZW1lbnRzLzEuMS8iIHhtbG5zOnhtcE1NPSJodHRwOi8vbnMuYWRvYmUuY29tL3hhcC8xLjAvbW0vIiB4bWxuczpzdFJlZj0iaHR0cDovL25zLmFkb2JlLmNvbS94YXAvMS4wL3NUeXBlL1Jlc291cmNlUmVmIyIgeG1wOkNyZWF0b3JUb29sPSJBZG9iZSBQaG90b3Nob3AgQ0MgMjAxNCAoTWFjaW50b3NoKSIgeG1wOkNyZWF0ZURhdGU9IjIwMTYtMDYtMTZUMTY6Mzg6MjAtMDc6MDAiIHhtcDpNb2RpZnlEYXRlPSIyMDE2LTA2LTE2VDIzOjM4OjM1LTA3OjAwIiB4bXA6TWV0YWRhdGFEYXRlPSIyMDE2LTA2LTE2VDIzOjM4OjM1LTA3OjAwIiBkYzpmb3JtYXQ9ImltYWdlL3BuZyIgeG1wTU06SW5zdGFuY2VJRD0ieG1wLmlpZDpDOTFDMEY3OTJDM0YxMUU2QjQ1MUVEMEFGMTU4MTUyOSIgeG1wTU06RG9jdW1lbnRJRD0ieG1wLmRpZDpDOTFDMEY3QTJDM0YxMUU2QjQ1MUVEMEFGMTU4MTUyOSI+IDx4bXBNTTpEZXJpdmVkRnJvbSBz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'

var synopsisNormalizer = () => {
  var i, duration, n, pct, publisher, results, total
  var data = []

  results = []
  underscore.keys(synopsis.publishers).forEach((publisher) => {
    results.push(underscore.extend({ publisher: publisher }, underscore.omit(synopsis.publishers[publisher], 'window')))
  }, synopsis)
  results = underscore.sortBy(results, (entry) => { return -entry.score })
  n = results.length

  total = 0
  for (i = 0; i < n; i++) { total += results[i].score }
  if (total === 0) return data

  pct = []
  for (i = 0; i < n; i++) {
    publisher = synopsis.publishers[results[i].publisher]
    duration = results[i].duration

    data[i] = { rank: i + 1,
                 site: results[i].publisher, views: results[i].visits, duration: duration,
                 daysSpent: 0, hoursSpent: 0, minutesSpent: 0, secondsSpent: 0,
                 faviconURL: publisher.faviconURL || faviconPNG
               }
    if (results[i].method) data[i].publisherURL = results[i].method + '://' + results[i].publisher
    pct[i] = Math.round((results[i].score * 100) / total)

    if (duration >= msecs.day) {
      data[i].daysSpent = Math.max(Math.round(duration / msecs.day), 1)
    } else if (duration >= msecs.hour) {
      data[i].hoursSpent = Math.max(Math.floor(duration / msecs.hour), 1)
      data[i].minutesSpent = Math.round((duration % msecs.hour) / msecs.minute)
    } else if (duration >= msecs.minute) {
      data[i].minutesSpent = Math.max(Math.round(duration / msecs.minute), 1)
      data[i].secondsSpent = Math.round((duration % msecs.minute) / msecs.second)
    } else {
      data[i].secondsSpent = Math.max(Math.round(duration / msecs.second), 1)
    }
  }

  pct = foo(pct, 100)
  for (i = 0; i < n; i++) {
    if (pct[i] === 0) {
      data = data.slice(0, i)
      break
    }

    data[i].percentage = pct[i]
  }

  return data
}

var publisherNormalizer = () => {
  var data = {}
  var then = underscore.now() - (7 * msecs.day)

  underscore.keys(publishers).sort().forEach((publisher) => {
    var entries = publishers[publisher]
    var i

    for (i = 0; i < entries.length; i++) if (entries[i].when > then) break
    if ((i !== 0) && (i !== entries.length)) entries = entries.slice(i)

    if (entries.length > 0) data[publisher] = entries
  })

  syncWriter(publisherPath, data, () => {})

  return data
}

// courtesy of https://stackoverflow.com/questions/13483430/how-to-make-rounded-percentages-add-up-to-100#13485888
var foo = (l, target) => {
  var off = target - underscore.reduce(l, (acc, x) => { return acc + Math.round(x) }, 0)

  return underscore.chain(l)
                   .sortBy((x) => { return Math.round(x) - x })
                   .map((x, i) => { return Math.round(x) + (off > i) - (i >= (l.length + off)) })
                   .value()
}

var cacheReturnValue = () => {
  var cache, paymentURL
  var info = returnValue._internal.paymentInfo

  if (!info) return

  if (!returnValue._internal.cache) returnValue._internal.cache = {}
  cache = returnValue._internal.cache

  paymentURL = 'bitcoin:' + info.address + '?amount=' + info.btc + '&label=' + encodeURI('Brave Software')
  // TBD: TEMPORARY UNTIL bitcoin: handler works
  paymentURL = 'https://www.coinbase.com/checkouts/9dccf22649d8dd6300259d66fef44a4e'
  if (cache.paymentURL === paymentURL) return

  cache.paymentURL = paymentURL
  cache.paymentIMG = 'https://chart.googleapis.com/chart?chs=150x150&chld=L|2&cht=qr&chl=' + encodeURI(cache.paymentURL)

  request.request({ url: cache.paymentIMG, responseType: 'blob' }, (err, response, blob) => {
/*
    console.log('\nresponse: ' + cache.paymentIMG +
                ' errP=' + (!!err) + ' blob=' + (blob || '').substr(0, 40) + '\n' + JSON.stringify(response, null, 2))
 */

    if (err) return console.log('response error: ' + err.toString())
    if ((response.statusCode !== 200) || (blob.indexOf('data:image/') !== 0)) return

    cache.paymentIMG = blob
  })
}

var triggerNotice = () => {
  console.log('\nledger notice: notifyP=' + returnValue.notifyP + ' paymentInfo=' +
                JSON.stringify(returnValue._internal.paymentInfo, null, 2))

  delete returnValue._internal.triggerID

  returnValue.notifyP = false
  if (!returnValue._internal.paymentInfo) return

  returnValue._internal.triggerID = setTimeout(() => { triggerNotice() }, 3 * msecs.hour)
  returnValue.notifyP = true
  console.log('ledger notice primed')
}

module.exports.handleLedgerVisit = (e, location) => {
  var i, publisher

  if ((!synopsis) || (!location)) return

  if ((locations) && (!locations[location])) {
    locations[location] = true

    try {
      publisher = LedgerPublisher.getPublisher(location)
      if (publisher) {
        if (!publishers[publisher]) publishers[publisher] = []
        publishers[publisher].push({ when: underscore.now(), location: location })

        delete returnValue.publishers
      }
    } catch (ex) {
      console.log('getPublisher error: ' + ex.toString())
    }
  }

  // If the location has changed and we have a previous timestamp
  if (location !== currentLocation && !(currentLocation || '').match(/^about/) && currentTS) {
    console.log('\naddVisit ' + currentLocation + ' for ' + moment.duration((new Date()).getTime() - currentTS).humanize())

// TBD: may need to have markup available...
    publisher = synopsis.addVisit(currentLocation, (new Date()).getTime() - currentTS)
    if (publisher) {
      i = location.indexOf(':/')
      if ((i > 0) && (!synopsis.publishers[publisher].method)) synopsis.publishers[publisher].method = location.substr(0, i)
/* TBD: should look for:

        <link rel='icon' href='...' />
        <link rel='shortcut icon' href='...' />
 */
      if ((publisher.indexOf('/') === -1) && (typeof synopsis.publishers[publisher].faviconURL === 'undefined') &&
          (synopsis.publishers[publisher].method)) {
/*
        console.log('request: ' + synopsis.publishers[publisher].method + '://' + publisher + '/favicon.ico')
 */
        synopsis.publishers[publisher].faviconURL = null
        request.request({ url: synopsis.publishers[publisher].method + '://' + publisher + '/favicon.ico',
                          responseType: 'blob' }, (err, response, blob) => {
/*
          console.log('\nresponse: ' + synopsis.publishers[publisher].method + '://' + publisher + '/favicon.ico' +
                      ' errP=' + (!!err) + ' blob=' + (blob || '').substr(0, 40) + '\n' + JSON.stringify(response, null, 2))
 */
          if (err) return console.log('response error: ' + err.toString())
          if ((response.statusCode !== 200) || (blob.indexOf('data:image/') !== 0)) return

          synopsis.publishers[publisher].faviconURL = blob
          syncWriter(synopsisPath, synopsis, () => {})
        })
      }

      syncWriter(synopsisPath, synopsis, () => {})

      delete returnValue.synopsis
    }
  }
  // record the new current location and timestamp
  currentLocation = location
  currentTS = (new Date()).getTime()
}

var handleGeneralCommunication = (event) => {
  var info, now, result, timestamp

  if (!returnValue.enabled) {
    event.returnValue = { enabled: false }
    return
  }

  publisherNormalizer()

  if (!returnValue.synopsis) returnValue.synopsis = synopsisNormalizer()

  if (returnValue._internal.reconcileStamp) {
    now = underscore.now()

    timestamp = now
    underscore.keys(synopsis.publishers).forEach((publisher) => {
      var then = underscore.last(synopsis.publishers[publisher].window).timestamp

      if (timestamp > then) timestamp = then
    })

    returnValue.statusText = 'Publisher synopsis as of ' + moment(timestamp).fromNow() + ', reconcilation due ' +
      moment(returnValue._internal.reconcileStamp)[now < returnValue._internal.reconcileStamp ? 'toNow' : 'fromNow']() + '.'
  }

  result = underscore.omit(returnValue, '_internal')
  info = returnValue._internal.paymentInfo
  if (info) {
    underscore.extend(result, underscore.pick(info, [ 'balance', 'address', 'btc', 'amount', 'currency' ]))
    if ((info.buyURLExpires) && (info.buyURLExpires > underscore.now())) {
      result.buyURL = info.buyURL
      result.buyIMG = coinbasePNG
    }

    underscore.extend(result, returnValue._internal.cache || {})
  }
  console.log('\n' + JSON.stringify(underscore.omit(result, [ 'synopsis', 'buyIMG', 'paymentIMG' ]), null, 2))

  returnValue.notifyP = false
  event.returnValue = result
}

// If we are in the main process
const ipc = require('electron').ipcMain

if (ipc) {
  ipc.on(messages.LEDGER_VISIT, module.exports.handleLedgerVisit)
  ipc.on(messages.LEDGER_GENERAL_COMMUNICATION, handleGeneralCommunication)
}
