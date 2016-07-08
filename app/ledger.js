/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

'use strict'

const fs = require('fs')
const path = require('path')
const util = require('util')

const electron = require('electron')
const app = electron.app
const session = electron.session

const moment = require('moment')
var qr = require('qr-image')
var random = require('random-lib')
const underscore = require('underscore')

const messages = require('../js/constants/messages')
const request = require('../js/lib/request')
const eventStore = require('../js/stores/eventStore')

// TBD: remove this post alpha [MTR]
const alphaPath = path.join(app.getPath('userData'), 'ledger-alpha.json')

// TBD: remove these post beta [MTR]
const logPath = path.join(app.getPath('userData'), 'ledger-log.json')
const publisherPath = path.join(app.getPath('userData'), 'ledger-publisher.json')

// TBD: move this into appStore.getState().get(‘ledger.client’) [MTR]
const statePath = path.join(app.getPath('userData'), 'ledger-state.json')

// TBD: move this into appStore.getState().get(‘publishers.synopsis’) [MTR]
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
var locations = {}
var publishers

var currentLocation = 'NOOP'
var currentTS = underscore.now()

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
          cacheReturnValue()

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
    underscore.keys(synopsis.publishers).forEach((publisher) => {
      if (synopsis.publishers[publisher].faviconURL === null) delete synopsis.publishers[publisher].faviconURL
    })

    fs.readFile(publisherPath, (err, data) => {
      publishers = {}

      if (err) {
        if (err.code !== 'ENOENT') console.log('publisherPath read error: ' + err.toString())
        return
      }

      try {
        publishers = JSON.parse(data)
        underscore.keys(publishers).sort().forEach((publisher) => {
          var entries = publishers[publisher]

          entries.forEach((entry) => { locations[entry.location] = entry })
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

  console.log('\nwhat? wait, how can this happen?')
}

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
                 faviconURL: publisher.faviconURL
               }
    if (results[i].protocol) data[i].publisherURL = results[i].protocol + '//' + results[i].publisher
    // TBD: temporary?!? [MTR]
    if (!data[i].publisherURL) data[i].publisherURL = 'http://' + results[i].publisher

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
  var chunks, cache, paymentURL
  var info = returnValue._internal.paymentInfo

  if (!info) return

  if (!returnValue._internal.cache) returnValue._internal.cache = {}
  cache = returnValue._internal.cache

  paymentURL = 'bitcoin:' + info.address + '?amount=' + info.btc + '&label=' + encodeURI('Brave Software')
  // TBD: TEMPORARY UNTIL bitcoin: handler works [MTR]
  paymentURL = 'https://www.coinbase.com/checkouts/9dccf22649d8dd6300259d66fef44a4e'
  if (cache.paymentURL === paymentURL) return

  cache.paymentURL = paymentURL
  try {
    chunks = []

    qr.image(paymentURL, { type: 'png' }).on('data', (chunk) => { chunks.push(chunk) }).on('end', () => {
      cache.paymentIMG = 'data:image/png;base64,' + Buffer.concat(chunks).toString('base64')
    })
  } catch (ex) {
    console.log('qr.imageSync error: ' + ex.toString())
  }
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

var fileTypes = {
  bmp: new Buffer([ 0x42, 0x4d ]),
  gif: new Buffer([ 0x47, 0x49, 0x46, 0x38, [0x37, 0x39], 0x61 ]),
  ico: new Buffer([ 0x00, 0x00, 0x01, 0x00 ]),
  jpeg: new Buffer([ 0xff, 0xd8, 0xff ]),
  png: new Buffer([ 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a ])
}

var signatureMax = 0
underscore.keys(fileTypes).forEach((fileType) => {
  if (signatureMax < fileTypes[fileType].length) signatureMax = fileTypes[fileType].length
})
signatureMax = Math.ceil(signatureMax * 1.5)

eventStore.addChangeListener(() => {
  var info = eventStore.getState().toJS().page_info

  if (!util.isArray(info)) return

  info.forEach((page) => {
    var entry, faviconURL, publisher
    var location = page.url

/*
    console.log('\npage=' + JSON.stringify(page, null, 2))
 */
    if ((!synopsis) || (location.match(/^about/)) || ((locations[location]) && (locations[location].publisher))) return

    if (!page.publisher) {
      try {
        publisher = LedgerPublisher.getPublisher(location)
        if (publisher) page.publisher = publisher
      } catch (ex) {
        console.log('getPublisher error for ' + location + ': ' + ex.toString())
      }
    }
    locations[location] = underscore.omit(page, [ 'url' ])
    if (!page.publisher) return

    synopsis.initPublisher(publisher)
    entry = synopsis.publishers[publisher]
    if ((page.protocol) && (!entry.protocol)) entry.protocol = page.protocol

    if ((typeof entry.faviconURL === 'undefined') && ((page.faviconURL) || (entry.protocol))) {
      var fetch = (url, redirects) => {
        if (typeof redirects === 'undefined') redirects = 0

        request.request({ url: url, responseType: 'blob' }, (err, response, blob) => {
          var prefix, tail

/*
          console.log('\nresponse: ' + url +
                      ' errP=' + (!!err) + ' blob=' + (blob || '').substr(0, 40) + '\nresponse=' +
                      JSON.stringify(response, null, 2))
 */

          if (err) return console.log('response error: ' + err.toString() + '\n' + err.stack)

          if ((response.statusCode === 301) && (response.headers.location)) {
            if (redirects < 3) fetch(response.headers.location, redirects++)
            return
          }

          if (response.statusCode !== 200) return

          if (blob.indexOf('data:image/') !== 0) {
            // NB: for some reason, some sites return an image, but with the wrong content-type...

            tail = blob.indexOf(';base64,')
            if (tail <= 0) return

            prefix = new Buffer(blob.substr(tail + 8, signatureMax), 'base64')
            underscore.keys(fileTypes).forEach((fileType) => {
              if ((prefix.length < fileTypes[fileType].length) &&
                  (fileTypes[fileType].compare(prefix, 0, fileTypes[fileType].length) !== 0)) return

              blob = 'data:image/' + fileType + blob.substr(tail)
            })
          }

          entry.faviconURL = blob
          syncWriter(synopsisPath, synopsis, () => {})
          console.log('\n' + publisher + ' synopsis=' +
                      JSON.stringify(underscore.extend(underscore.omit(entry, [ 'faviconURL' ]),
                                                       { faviconURL: entry.faviconURL && '... ' }), null, 2))
        })
      }

      faviconURL = page.faviconURL || entry.protocol + '//' + publisher + '/favicon.ico'
      entry.faviconURL = null

      console.log('request: ' + faviconURL)
      fetch(faviconURL)

      syncWriter(synopsisPath, synopsis, () => {})
      delete returnValue.synopsis
    }
  })
})

var handleLedgerPublisher = (event) => {
  event.returnValue = (event.sender.session !== session.fromPartition('default')) ? LedgerPublisher.rules : []
}

module.exports.handleLedgerVisit = (event, location, reason) => {
  var now = underscore.now()

  var setLocation = () => {
    var duration, publisher

    if ((!synopsis) || (currentLocation === 'NOOP')) return

    console.log('locations[' + currentLocation + ']=' + JSON.stringify(locations[currentLocation], null, 2))
    if (!locations[currentLocation]) return

    publisher = locations[currentLocation].publisher
    if (!publisher) return

    if (!publishers[publisher]) publishers[publisher] = []
    publishers[publisher].push({ location: currentLocation, when: currentTS })

    publisherNormalizer()
    delete returnValue.publishers

    if (location === currentLocation) return true

    duration = now - currentTS
    console.log('addVisit ' + currentLocation + ' for ' + moment.duration(duration).humanize())
    synopsis.addPublisher(publisher, duration)
  }

  console.log('\n' + (location === currentLocation ? 'same' : 'new') + ' location: ' + location + ' reason: ' + reason)
  if (setLocation()) return

  currentLocation = location.match(/^about/) ? 'NOOP' : location
  currentTS = now
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
    if ((info.buyURLExpires) && (info.buyURLExpires > underscore.now())) result.buyURL = info.buyURL

    underscore.extend(result, returnValue._internal.cache || {})
  }
/*
  console.log('\n' + JSON.stringify(underscore.extend(underscore.omit(result, [ 'synopsis', 'paymentIMG' ]),
                                                      { synopsis: result.synopsis && '...',
                                                        paymentIMG: result.paymentIMG && '...' }), null, 2))
 */

  returnValue.notifyP = false
  event.returnValue = result
}

// If we are in the main process
const ipc = require('electron').ipcMain

if (ipc) {
  ipc.on(messages.LEDGER_PUBLISHER, handleLedgerPublisher)
  ipc.on(messages.LEDGER_VISIT, module.exports.handleLedgerVisit)
  ipc.on(messages.LEDGER_GENERAL_COMMUNICATION, handleGeneralCommunication)
}
