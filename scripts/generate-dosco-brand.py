import os
from PIL import Image

CREST_SRC = 'C:/Users/kage/.gemini/antigravity/brain/332e3e1e-2717-4d4d-9aad-22651af45bfb/.user_uploaded/media_1793488983849_39c431ef.png'
WORDMARK_SRC = 'C:/Users/kage/.gemini/antigravity/brain/332e3e1e-2717-4d4d-9aad-22651af45bfb/.user_uploaded/media_1793489016010_abff4421.png'
OUT_DIR = 'apps/web/public/brand'

def transparent_from_black(img, bg_thresh=8, is_wordmark=False):
    """
    Remove solid black background and produce dark and light versions.
    Unmultiplies edges to eliminate dark halos.
    """
    rgb = img.convert('RGB')
    w, h = rgb.size
    
    out_dark = Image.new('RGBA', (w, h))
    out_light = Image.new('RGBA', (w, h))
    
    src = rgb.load()
    dst_d = out_dark.load()
    dst_l = out_light.load()
    
    for y in range(h):
        for x in range(w):
            r, g, b = src[x, y]
            v = max(r, g, b)
            
            if v <= bg_thresh:
                dst_d[x, y] = (0, 0, 0, 0)
                dst_l[x, y] = (0, 0, 0, 0)
            else:
                # Soft alpha ramp
                alpha = min(255, int(255 * ((v - bg_thresh) / (255.0 - bg_thresh)) ** 0.85 * 1.15))
                # Unmultiply to remove dark fringe
                scale = 255.0 / max(1, v)
                nr = min(255, int(r * scale))
                ng = min(255, int(g * scale))
                nb = min(255, int(b * scale))
                
                dst_d[x, y] = (nr, ng, nb, alpha)
                
                # Check for fiery red flame vs silver chrome text
                is_fiery = (r > 100 and r > g * 1.35) or (x > 750 and is_wordmark and r > 120 and r > g * 1.2)
                
                if is_fiery or not is_wordmark:
                    # Keep the vivid red/orange fiery mark on light background too
                    dst_l[x, y] = (nr, ng, nb, alpha)
                else:
                    # Invert silver chrome text to deep ink/charcoal (#1a1a1a with bevel highlights)
                    lum = int(0.299 * nr + 0.587 * ng + 0.114 * nb)
                    dark_val = int(20 + (255 - lum) * 0.45)
                    dst_l[x, y] = (dark_val, dark_val, int(dark_val * 1.05), alpha)
                    
    return out_dark, out_light

def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    
    # 1. Process Wordmark
    im_wm = Image.open(WORDMARK_SRC)
    wm_dark, wm_light = transparent_from_black(im_wm, bg_thresh=10, is_wordmark=True)
    
    # Crop tightly to content
    bbox_wm = wm_dark.getbbox()
    if bbox_wm:
        # Add 4px margin
        box = (max(0, bbox_wm[0] - 4), max(0, bbox_wm[1] - 4), min(wm_dark.width, bbox_wm[2] + 4), min(wm_dark.height, bbox_wm[3] + 4))
        wm_dark = wm_dark.crop(box)
        wm_light = wm_light.crop(box)
        
    wm_dark.save(os.path.join(OUT_DIR, 'dosco-wordmark-dark.png'), 'PNG')
    wm_light.save(os.path.join(OUT_DIR, 'dosco-wordmark-light.png'), 'PNG')
    print('Saved wordmarks from user upload:', wm_dark.size)
    
    # 2. Process Crest
    im_crest = Image.open(CREST_SRC)
    crest_dark, crest_light = transparent_from_black(im_crest, bg_thresh=10, is_wordmark=False)
    
    # Center crest in square
    bbox_c = crest_dark.getbbox()
    if bbox_c:
        # Center in square box
        cw = bbox_c[2] - bbox_c[0]
        ch = bbox_c[3] - bbox_c[1]
        dim = max(cw, ch) + 16
        cx = (bbox_c[0] + bbox_c[2]) // 2
        cy = (bbox_c[1] + bbox_c[3]) // 2
        box = (cx - dim // 2, cy - dim // 2, cx + dim // 2, cy + dim // 2)
        
        # Safe crop with padding
        sq_dark = Image.new('RGBA', (dim, dim), (0, 0, 0, 0))
        sq_light = Image.new('RGBA', (dim, dim), (0, 0, 0, 0))
        paste_x = (dim - (bbox_c[2] - bbox_c[0])) // 2
        paste_y = (dim - (bbox_c[3] - bbox_c[1])) // 2
        
        c_crop_d = crest_dark.crop(bbox_c)
        c_crop_l = crest_light.crop(bbox_c)
        
        sq_dark.paste(c_crop_d, (paste_x, paste_y))
        sq_light.paste(c_crop_l, (paste_x, paste_y))
        
        crest_dark = sq_dark
        crest_light = sq_light
        
    crest_dark.save(os.path.join(OUT_DIR, 'dosco-icon-dark.png'), 'PNG')
    crest_light.save(os.path.join(OUT_DIR, 'dosco-icon-light.png'), 'PNG')
    crest_dark.save(os.path.join(OUT_DIR, 'dosco-crest.png'), 'PNG')
    print('Saved crests from user upload:', crest_dark.size)

if __name__ == '__main__':
    main()
