/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

let results = {}

let node = document.head.querySelector("link[rel='icon']")
if (!node) node = document.head.querySelector("link[rel='shortcut icon']")
if (node) results.faviconURL = node.getAttribute('href')

// hard-coded for now... will be dynamic in the beta (I hope!)
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

if ((results.faviconURL) && (results.faviconURL.indexOf('//') === 0)) {
  results.faviconURL = document.location.protocol + results.faviconURL
}

if (Object.keys(results).length !== 0) {
  results.protocol = document.location.protocol
  ExtensionActions.setPageInfo(href, results)
}
