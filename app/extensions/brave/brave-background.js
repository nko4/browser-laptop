{
  let ledgerPublisherConfig = {}

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!sender.tab || sender.tab.incognito || sender.id !== chrome.runtime.id)
      return

    if (msg.type === 'ledger-publisher-config') {
      sendResponse(ledgerPublisherConfig)
    }
  })

  chrome.ipc.on('background-page-message', (evt, msg) => {
    if (msg.type === 'ledger-publisher-update') {
      ledgerPublisherConfig = msg.config
    }
  })
}
