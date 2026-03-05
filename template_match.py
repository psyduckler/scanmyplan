#!/usr/bin/env python3
"""Template matching for salon floor plan items using OpenCV."""
import cv2
import numpy as np
import json
import sys
import os
import glob

def multi_scale_match(image_gray, template_gray, scales=[0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0, 1.1, 1.2], threshold=0.65):
    """Find all matches of template in image across multiple scales."""
    matches = []
    th, tw = template_gray.shape[:2]
    ih, iw = image_gray.shape[:2]
    
    for scale in scales:
        sw, sh = int(tw * scale), int(th * scale)
        if sw < 10 or sh < 10 or sw > iw or sh > ih:
            continue
        
        scaled = cv2.resize(template_gray, (sw, sh))
        result = cv2.matchTemplate(image_gray, scaled, cv2.TM_CCOEFF_NORMED)
        
        locations = np.where(result >= threshold)
        for pt_y, pt_x in zip(*locations):
            matches.append({
                'x': int(pt_x), 'y': int(pt_y),
                'width': sw, 'height': sh,
                'confidence': float(result[pt_y, pt_x]),
                'scale': scale
            })
    
    # Non-maximum suppression - remove overlapping detections
    if not matches:
        return []
    
    matches.sort(key=lambda m: m['confidence'], reverse=True)
    filtered = []
    for m in matches:
        overlap = False
        for f in filtered:
            # Check IoU
            x1 = max(m['x'], f['x'])
            y1 = max(m['y'], f['y'])
            x2 = min(m['x'] + m['width'], f['x'] + f['width'])
            y2 = min(m['y'] + m['height'], f['y'] + f['height'])
            if x2 > x1 and y2 > y1:
                inter = (x2-x1) * (y2-y1)
                area1 = m['width'] * m['height']
                area2 = f['width'] * f['height']
                iou = inter / min(area1, area2)
                if iou > 0.3:
                    overlap = True
                    break
        if not overlap:
            filtered.append(m)
    
    return filtered


def match_floor_plan(image_path, templates_dir):
    """Find all template matches in a floor plan image."""
    image = cv2.imread(image_path)
    if image is None:
        return {'error': f'Cannot read image: {image_path}'}
    
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    
    all_matches = {}
    template_files = sorted(glob.glob(os.path.join(templates_dir, '*.png')))
    
    for tf in template_files:
        name = os.path.splitext(os.path.basename(tf))[0]
        template = cv2.imread(tf, cv2.IMREAD_GRAYSCALE)
        if template is None:
            continue
        
        matches = multi_scale_match(gray, template, threshold=0.6)
        if matches:
            all_matches[name] = matches
            print(f"  {name}: {len(matches)} matches (best conf: {matches[0]['confidence']:.3f})", file=sys.stderr)
    
    return all_matches


if __name__ == '__main__':
    if len(sys.argv) < 2:
        print("Usage: template_match.py <image_path> [templates_dir]", file=sys.stderr)
        sys.exit(1)
    
    image_path = sys.argv[1]
    templates_dir = sys.argv[2] if len(sys.argv) > 2 else 'templates'
    
    print(f"Matching templates in {image_path}...", file=sys.stderr)
    results = match_floor_plan(image_path, templates_dir)
    print(json.dumps(results))
