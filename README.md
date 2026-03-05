# ScanMyPlan — Salon Floorplan Detector

Detect salon furniture items in floor plan images using Gemini 2.5 Pro vision.

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/psyduckler/scanmyplan)

## Deploy on Render

1. Click the deploy button above
2. Set the `GEMINI_API_KEY` environment variable
3. Done — builds and deploys automatically

## Local Development

```bash
export GEMINI_API_KEY=your-key
npm install
npm start
# Visit http://localhost:3456
```

## Features

- Upload salon floor plan PNG → AI detects furniture items with bounding boxes
- Split-view: item table (left) + floor plan with hover highlights (right)
- Edit/delete detected items inline
- Download results as JSON or CSV
- Permalink for each analysis
- OCR-based room boundary detection (Python + Tesseract)
