#!/bin/sh
# Retakes the README screenshots into .github/readme/. Start the dev server
# first (`npm run dev`, port 5173). Uses Google Chrome in headless mode.
# The page is a made-up demo (page1.svg); never use real manga pages here.
set -e
cd "$(dirname "$0")/../.."
B=http://localhost:5173/scripts/readme-shots/shot.html
node scripts/readme-shots/shot.mjs "$B?s=editor" .github/readme/editor.png 1600 1000 2
node scripts/readme-shots/shot.mjs "$B?s=translate" .github/readme/translate.png 1600 1000 2
node scripts/readme-shots/shot.mjs "$B?s=fonts&window=fonts" .github/readme/fonts.png 1400 900 2
