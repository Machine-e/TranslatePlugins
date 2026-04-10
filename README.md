# Stream Translate Page

A Chrome Manifest V3 extension that translates English-heavy webpage content into Simplified Chinese and inserts the translation under the original text.

## Features

- Manual full-page translation from the popup
- OpenAI-compatible custom provider via `responses`
- Batch-by-batch flow so earlier paragraphs appear first
- Inline insertion under each original block (tables and sidebar supported)
- Skip Chinese-heavy content, most UI chrome, forms, and hidden nodes
- Code blocks: translate comments only (not code)
- Stop, clear, hide/show, and retry failed segments

## Local setup

1. Open `chrome://extensions`
2. Enable `Developer mode`
3. Click `Load unpacked`
4. Select the folder containing `manifest.json`

## Provider settings

Open the extension options page and configure:

- `Base URL`, for example `https://api.openai.com/v1` or your own OpenAI-compatible endpoint
- `API Key` (kept in browser local storage)
- `Model`
- Optional custom system prompt
- Timeout and batch size

The extension will call:

`{Base URL}/responses`

## Security notes

- Do not commit or share your API key. This repo contains no real keys (only placeholders).
- The API key is stored locally via `chrome.storage.local` and is sent to the configured provider when translating.

## Usage

1. Open an English webpage
2. Click the extension icon
3. Click `开始翻译`
4. Use `隐藏译文`, `停止`, or `清除当前页` as needed

If a batch fails, the page keeps completed translations and shows `重试该段` under failed segments.
