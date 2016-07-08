/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

if (window.top === window.self) {
  let results = { protocol: document.location.protocol }
// require('../../../../../js/constants/messages.js').LEDGER_PUBLISHER == 'ledger-publisher' [MTR]
//let rules = chrome.ipc.sendSync('ledger-publisher')

  let node = document.head.querySelector("link[rel='icon']")
  if (!node) node = document.head.querySelector("link[rel='shortcut icon']")
  if (node) results.faviconURL = node.getAttribute('href')

// TBD: hard-coded for now... will be dynamic soon! [MTR]
  let href = document.location.href
  if (href.indexOf('www.youtube.com/watch?') !== -1) {
    node = document.body.querySelector("#watch7-content.watch-main-col meta[itemprop='channelId']")
    if (node) results.publisher = 'youtube.com/channel/' + node.getAttribute('content')

    node = document.body.querySelector('#watch7-user-header.spf-link img')
    let faviconURL = node && node.getAttribute('data-thumb')
    if (faviconURL) results.faviconURL = faviconURL
  }

  if (document.location.hostname === 'twitter.com') {
    node = document.body.querySelector('img.ProfileAvatar-image')
    let faviconURL = node && node.getAttribute('src')
    if (faviconURL) results.faviconURL = faviconURL
  }

  if (results.faviconURL) {
    let prefix = (results.faviconURL.indexOf('//') === 0) ? document.location.protocol
                 : (results.faviconURL.indexOf('/') === 0) ? document.location.protocol + '//' + document.location.host
                 : (results.faviconURL.indexOf(':') === -1) ? document.location.protocol + '//' + document.location.host + '/'
                 : null
    if (prefix) results.faviconURL = prefix + results.faviconURL
  }
  
  ExtensionActions.setPageInfo(href, results)
}
