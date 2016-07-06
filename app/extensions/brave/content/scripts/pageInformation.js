/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */


let results = {}

let node = document.head.querySelector("link[rel='icon']")
if (!node) node = document.head.querySelector("link[rel='shortcut icon']")
if (node) results.favicon = node.getAttribute('href')

// hard-coded for now... will be dynamic in the beta (I hope!)
let href = document.location.href
if (href.hostname === 'youtube.com' && href.pathname.indexOf('/channel') === 0) {
  node = document.body.querySelector("#watch7-content.watch-main-col meta[itemprop='channelId']")
  if (node) results.publisher = node.getAttribute('content')
}

if (Object.keys(results).length !== 0) ExtensionActions.setPageInfo(href, results)
