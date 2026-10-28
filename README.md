# Gentle Sender

Sends one personalised message to a list of contacts through WhatsApp Web,
one at a time, with random gaps, breaks, a daily cap and sending hours.

## Install

**Brave / Chrome / Edge**
1. Open `brave://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and choose this folder.
3. Click the extension icon to open the dashboard.

**Firefox (121+)**
1. Open `about:debugging#/runtime/this-firefox`, then **Load Temporary Add-on**, and pick `manifest.json`.
2. Open the dashboard and click **Open WhatsApp Web**. Allow access to web.whatsapp.com when asked.
   (Temporary add-ons are removed when Firefox restarts.)

## Use

1. Log in to WhatsApp Web in this browser.
2. Upload .vcf / .csv files or paste contacts. Invalid numbers are listed so you can fix them.
3. Write the message. `{name}` = first name, `{name|ji}` = "ji" when there is no name.
4. Send a test to your own number, then press **Start**.
5. Leave the browser open (the WhatsApp tab can be in the background). Progress survives
   restarts. A message that was mid-send when the browser closed is marked failed, never re-sent.

## How it sends

For each contact, it opens `web.whatsapp.com/send?phone=…&text=…` in the WhatsApp tab,
waits for the chat to load with the text filled in, then clicks Send. If WhatsApp changes its
page layout and sending stops working, update the selectors in `content.js`.
