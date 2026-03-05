FROM node:20-bookworm-slim

# Install system deps
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip python3-venv \
    tesseract-ocr \
    libgl1 libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

# Install Python deps in a venv to avoid system package conflicts
RUN python3 -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"
RUN pip install --no-cache-dir pytesseract opencv-python-headless numpy

WORKDIR /app

# Copy package files and install
COPY package.json package-lock.json ./
RUN npm ci --production

# Copy app source
COPY . .

# Temp dir for OCR processing (ephemeral, no persistence needed)
RUN mkdir -p /tmp/scanmyplan

EXPOSE 10000

CMD ["node", "server.js"]
