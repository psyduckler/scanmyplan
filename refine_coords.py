#!/usr/bin/env python3
"""Refine Gemini's approximate bounding boxes using template matching within a search region."""
import cv2
import numpy as np
import json
import sys
import os
import glob

def load_templates(templates_dir):
    """Load templates cropped from Q1002 floor plan."""
    templates = {}
    for tf in sorted(glob.glob(os.path.join(templates_dir, '*.png'))):
        name = os.path.splitext(os.path.basename(tf))[0]
        img = cv2.imread(tf, cv2.IMREAD_GRAYSCALE)
        if img is not None:
            templates[name] = img
    return templates

def refine_bbox(image_gray, template, approx_x, approx_y, approx_w, approx_h, search_margin=2.0):
    """Refine an approximate bounding box by template matching in a search region."""
    ih, iw = image_gray.shape[:2]
    th, tw = template.shape[:2]
    
    # Expand search region around Gemini's guess
    cx, cy = approx_x + approx_w/2, approx_y + approx_h/2
    search_w = int(max(approx_w, tw) * search_margin)
    search_h = int(max(approx_h, th) * search_margin)
    
    sx1 = max(0, int(cx - search_w))
    sy1 = max(0, int(cy - search_h))
    sx2 = min(iw, int(cx + search_w))
    sy2 = min(ih, int(cy + search_h))
    
    region = image_gray[sy1:sy2, sx1:sx2]
    if region.shape[0] < 10 or region.shape[1] < 10:
        return None
    
    best_match = None
    best_conf = -1
    
    # Try multiple scales
    for scale in [0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0, 1.1, 1.2, 1.5]:
        sw, sh = int(tw * scale), int(th * scale)
        if sw < 5 or sh < 5 or sw >= region.shape[1] or sh >= region.shape[0]:
            continue
        
        scaled = cv2.resize(template, (sw, sh))
        result = cv2.matchTemplate(region, scaled, cv2.TM_CCOEFF_NORMED)
        _, max_val, _, max_loc = cv2.minMaxLoc(result)
        
        if max_val > best_conf:
            best_conf = max_val
            best_match = {
                'x': sx1 + max_loc[0],
                'y': sy1 + max_loc[1],
                'width': sw,
                'height': sh,
                'confidence': float(max_val),
                'scale': scale
            }
    
    # Only return if confidence is decent
    if best_match and best_match['confidence'] > 0.45:
        return best_match
    return None

# Map item names to template file names
NAME_TO_TEMPLATE = {
    'Styling Chair': 'Styling_Chair',
    'Mirror': 'Mirror',
    'Rolling Cart': 'Rolling_Cart',
    '63in Cabinet - LEFT ': '63in_Cabinet___LEFT',
    '63in Cabinet - RIGHT': '63in_Cabinet___RIGHT',
    '47in Cabinet - LEFT ': '47in_Cabinet___LEFT',
    '47in Cabinet - RIGHT': '47in_Cabinet___RIGHT',
    'Shampoo Shuttle': 'Shampoo_Shuttle',
    'RIGHT Hand Sliding D': 'RIGHT_Hand_Sliding_D',
    'LEFT Hand Sliding Do': 'LEFT_Hand_Sliding_Do',
}

if __name__ == '__main__':
    if len(sys.argv) < 3:
        print("Usage: refine_coords.py <image_path> <items_json_file>", file=sys.stderr)
        sys.exit(1)
    
    image_path = sys.argv[1]
    items_json = open(sys.argv[2]).read()
    templates_dir = 'templates/from_floorplan'
    
    image = cv2.imread(image_path)
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    items = json.loads(items_json)
    templates = load_templates(templates_dir)
    
    refined_count = 0
    for item in items:
        name = item.get('ItemName', '')
        tmpl_name = NAME_TO_TEMPLATE.get(name)
        if not tmpl_name or tmpl_name not in templates:
            continue
        
        coords = json.loads(item['Coordinates'])
        result = refine_bbox(
            gray, templates[tmpl_name],
            coords['x'], coords['y'], coords['width'], coords['height']
        )
        
        if result:
            item['Coordinates'] = json.dumps({
                'x': result['x'], 'y': result['y'],
                'width': result['width'], 'height': result['height']
            })
            item['_refined'] = True
            item['_refine_conf'] = round(result['confidence'], 3)
            refined_count += 1
    
    print(f"Refined {refined_count}/{len(items)} items", file=sys.stderr)
    print(json.dumps(items))
