# Notion Word Counter

A Chrome extension that keeps a live word count on screen while you write in Notion, like Google Docs' "Display word count while typing". Highlight text or select blocks and it switches to "56 of 1,234 words".

## What it shows

Click the floating box (or the toolbar icon) for the full breakdown. Every stat reads "X of Y" when something is highlighted.

- Pages (estimated at ~500 words per single-spaced page)
- Words
- Characters
- Characters excluding spaces
- Paragraphs
- Sentences
- Reading time (238 wpm)
- Speaking time (140 wpm)

It counts the page you're working in, including side peek, center peek, Notion split view and Chrome split view. It follows Notion's light or dark theme, and you can drag the box anywhere.

## Install

1. Download or clone this repo.
2. Go to `chrome://extensions` and turn on **Developer mode**.
3. Click **Load unpacked** and choose the repo folder.
4. Open a Notion page in the browser.

Also works in Edge, Arc and Brave. The Notion desktop app doesn't support extensions. To get an app-like window with the counter, open Notion in Chrome and use ⋮ → **Cast, save, and share → Install page as app**.
