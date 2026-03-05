#!/usr/bin/env python3
"""Detect room number labels via OCR — returns label positions."""

import sys, json, re, cv2, numpy as np, pytesseract

def detect_rooms(image_path):
    img = cv2.imread(image_path)
    if img is None:
        return []
    h, w = img.shape[:2]
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    
    data = pytesseract.image_to_data(gray, config='--psm 11', output_type=pytesseract.Output.DICT)
    
    seen = {}
    room_pat = re.compile(r'^(\d{2,4}|HW\d*|HALL\w*|CORRIDOR)$', re.IGNORECASE)
    
    for i in range(len(data['text'])):
        text = data['text'][i].strip()
        conf = int(data['conf'][i])
        if conf < 20 or not text:
            continue
        if room_pat.match(text):
            room_no = text
        else:
            m = re.search(r'(\d{2,4})', text)
            if m: room_no = m.group(1)
            else: continue
        
        tx = data['left'][i]
        ty = data['top'][i]
        tw = data['width'][i]
        th = data['height'][i]
        
        if room_no in seen and seen[room_no]['conf'] >= conf:
            continue
        seen[room_no] = {'tx': tx, 'ty': ty, 'tw': tw, 'th': th, 'conf': conf}
    
    results = []
    margin = 8
    for room_no, d in seen.items():
        results.append({
            'RoomNo': room_no,
            'x': d['tx'] - margin,
            'y': d['ty'] - margin,
            'width': d['tw'] + margin * 2,
            'height': d['th'] + margin * 2
        })
    return results

if __name__ == '__main__':
    if len(sys.argv) < 2:
        print(json.dumps([]))
        sys.exit(1)
    rooms = detect_rooms(sys.argv[1])
    print(json.dumps(rooms))
