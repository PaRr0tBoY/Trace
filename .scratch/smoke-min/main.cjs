const { app, BrowserWindow } = require('electron')
app.whenReady().then(() => {
  const w = new BrowserWindow({ show: false })
  console.log('MINI-OK')
  setTimeout(() => { app.exit(0) }, 1500)
})
