# Salon Floorplan Detector

Detects salon furniture items in floor plan images using Gemini 2.5 Pro vision.

## Setup

```bash
cd /Users/psy/salon-floorplan-detector
npm install
npm start
```

Open http://localhost:3456

## API Key

Set `GEMINI_API_KEY` env var, or it will auto-read from macOS Keychain (`google-api-key`).

## Usage

1. Enter Document No and Customer
2. Drag & drop a floor plan PNG
3. Click "Detect Items"
4. Download results as JSON or CSV
