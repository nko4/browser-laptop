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

  if (entries) {
    then = now - (7 * msecs.day)
    logs = logs.concat(entries)

    for (i = 0; i < logs.length; i++) if (logs[i].when > then) break
    if ((i !== 0) && (i !== logs.length)) logs = logs.slice(i)
    if (result) entries.push({ who: 'callback', what: result, when: underscore.now() })

    syncWriter(logPath, entries, { flag: 'a' }, () => {})
  }

  if (err) {
    console.log('ledger client error: ' + err.toString() + '\n' + err.stack)
    return setTimeout(() => {
      if (client.sync(callback) === true) run(random.randomInt({ min: 0, max: 10 * msecs.minute }))
    }, 1 * msecs.hour)
  }

  returnValue.enabled = true

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
    returnValue.statusText = ''
  } else {
    returnValue.statusText = 'Initializing'
  }

  syncWriter(statePath, result, () => { run(delayTime) })
}

var run = (delayTime) => {
/*
  console.log('\nledger client run: delayTime=' + delayTime)
 */

  if (delayTime === 0) {
    delayTime = client.timeUntilReconcile()
    if (delayTime === false) delayTime = 0
  }
  if (delayTime > 0) return setTimeout(() => { if (client.sync(callback) === true) return run(0) }, delayTime)

  if (client.isReadyToReconcile()) return client.reconcile(synopsis.topN(topPublishersN), callback)

  console.log('\nwhat? wait.')
}

const faviconPNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAYAAADgdz34AAAAGXRFWHRTb2Z0d2FyZQBBZG9iZSBJbWFnZVJlYWR5ccllPAAAA0xpVFh0WE1MOmNvbS5hZG9iZS54bXAAAAAAADw/eHBhY2tldCBiZWdpbj0i77u/IiBpZD0iVzVNME1wQ2VoaUh6cmVTek5UY3prYzlkIj8+IDx4OnhtcG1ldGEgeG1sbnM6eD0iYWRvYmU6bnM6bWV0YS8iIHg6eG1wdGs9IkFkb2JlIFhNUCBDb3JlIDUuNi1jMTExIDc5LjE1ODMyNSwgMjAxNS8wOS8xMC0wMToxMDoyMCAgICAgICAgIj4gPHJkZjpSREYgeG1sbnM6cmRmPSJodHRwOi8vd3d3LnczLm9yZy8xOTk5LzAyLzIyLXJkZi1zeW50YXgtbnMjIj4gPHJkZjpEZXNjcmlwdGlvbiByZGY6YWJvdXQ9IiIgeG1sbnM6eG1wTU09Imh0dHA6Ly9ucy5hZG9iZS5jb20veGFwLzEuMC9tbS8iIHhtbG5zOnN0UmVmPSJodHRwOi8vbnMuYWRvYmUuY29tL3hhcC8xLjAvc1R5cGUvUmVzb3VyY2VSZWYjIiB4bWxuczp4bXA9Imh0dHA6Ly9ucy5hZG9iZS5jb20veGFwLzEuMC8iIHhtcE1NOkRvY3VtZW50SUQ9InhtcC5kaWQ6MUNFNTM2NTcxQzQyMTFFNjhEODk5OTY1MzJCOUU0QjEiIHhtcE1NOkluc3RhbmNlSUQ9InhtcC5paWQ6MUNFNTM2NTYxQzQyMTFFNjhEODk5OTY1MzJCOUU0QjEiIHhtcDpDcmVhdG9yVG9vbD0iQWRvYmUgUGhvdG9zaG9wIENDIDIwMTUgKE1hY2ludG9zaCkiPiA8eG1wTU06RGVyaXZlZEZyb20gc3RSZWY6aW5zdGFuY2VJRD0iYWRvYmU6ZG9jaWQ6cGhvdG9zaG9wOjUxZDUzZDBmLTYzOWMtMTE3OS04Yjk3LTg3Y2M5YTUyOWRmMSIgc3RSZWY6ZG9jdW1lbnRJRD0iYWRvYmU6ZG9jaWQ6cGhvdG9zaG9wOjUxZDUzZDBmLTYzOWMtMTE3OS04Yjk3LTg3Y2M5YTUyOWRmMSIvPiA8L3JkZjpEZXNjcmlwdGlvbj4gPC9yZGY6UkRGPiA8L3g6eG1wbWV0YT4gPD94cGFja2V0IGVuZD0iciI/PmF3+n4AAAAoSURBVHja7M1BAQAABAQw9O98SvDbCqyT1KepZwKBQCAQCAQ3VoABAAu6Ay00hnjWAAAAAElFTkSuQmCC'

const coinbasePNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAJYAAACWCAIAAACzY+a1AAAAGXRFWHRTb2Z0d2FyZQBBZG9iZSBJbWFnZVJlYWR5ccllPAAAA+1pVFh0WE1MOmNvbS5hZG9iZS54bXAAAAAAADw/eHBhY2tldCBiZWdpbj0i77u/IiBpZD0iVzVNME1wQ2VoaUh6cmVTek5UY3prYzlkIj8+IDx4OnhtcG1ldGEgeG1sbnM6eD0iYWRvYmU6bnM6bWV0YS8iIHg6eG1wdGs9IkFkb2JlIFhNUCBDb3JlIDUuNi1jMDE0IDc5LjE1Njc5NywgMjAxNC8wOC8yMC0wOTo1MzowMiAgICAgICAgIj4gPHJkZjpSREYgeG1sbnM6cmRmPSJodHRwOi8vd3d3LnczLm9yZy8xOTk5LzAyLzIyLXJkZi1zeW50YXgtbnMjIj4gPHJkZjpEZXNjcmlwdGlvbiByZGY6YWJvdXQ9IiIgeG1sbnM6eG1wPSJodHRwOi8vbnMuYWRvYmUuY29tL3hhcC8xLjAvIiB4bWxuczpkYz0iaHR0cDovL3B1cmwub3JnL2RjL2VsZW1lbnRzLzEuMS8iIHhtbG5zOnhtcE1NPSJodHRwOi8vbnMuYWRvYmUuY29tL3hhcC8xLjAvbW0vIiB4bWxuczpzdFJlZj0iaHR0cDovL25zLmFkb2JlLmNvbS94YXAvMS4wL3NUeXBlL1Jlc291cmNlUmVmIyIgeG1wOkNyZWF0b3JUb29sPSJBZG9iZSBQaG90b3Nob3AgQ0MgMjAxNCAoTWFjaW50b3NoKSIgeG1wOkNyZWF0ZURhdGU9IjIwMTYtMDYtMjFUMTY6MjM6MjEtMDc6MDAiIHhtcDpNb2RpZnlEYXRlPSIyMDE2LTA2LTIxVDIzOjIzOjMwLTA3OjAwIiB4bXA6TWV0YWRhdGFEYXRlPSIyMDE2LTA2LTIxVDIzOjIzOjMwLTA3OjAwIiBkYzpmb3JtYXQ9ImltYWdlL3BuZyIgeG1wTU06SW5zdGFuY2VJRD0ieG1wLmlpZDo4MUMwQzUwMzMwMkIxMUU2QjRFREQ0MEVEQkI1MzUzMCIgeG1wTU06RG9jdW1lbnRJRD0ieG1wLmRpZDo4MUMwQzUwNDMwMkIxMUU2QjRFREQ0MEVEQkI1MzUzMCI+IDx4bXBNTTpEZXJpdmVkRnJvbSBz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'

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

        publisherNormalizer()
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

  now = underscore.now()

  timestamp = now
  underscore.keys(synopsis.publishers).forEach((publisher) => {
    var then = underscore.last(synopsis.publishers[publisher].window).timestamp

    if (timestamp > then) timestamp = then
  })
  returnValue.statusText = 'Publisher synopsis as of ' + moment(timestamp).fromNow()
  if (returnValue._internal.reconcileStamp) {
    returnValue.statusText += ', reconcilation due ' + moment(returnValue._internal.reconcileStamp).fromNow()
  }
  returnValue.statusText += '.'

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
