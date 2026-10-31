import os
from PIL import Image

def extract_with_screen_blend(crop_img):
    """Convert black background to transparency using screen blending / luminance."""
    crop_img = crop_img.convert('RGBA')
    w, h = crop_img.size
    pixels = list(crop_img.getdata())
    out_dark = []
    out_light = []
    
    for r, g, b, a in pixels:
        lum = max(r, g, b)
        if lum <= 8:
            out_dark.append((0, 0, 0, 0))
            out_light.append((0, 0, 0, 0))
        else:
            # Alpha based on brightness
            alpha = min(255, int(255 * (lum / 255.0) ** 0.8 * 1.25))
            # Boost brightness for clean display
            out_dark.append((r, g, b, alpha))
            
            # For light theme: invert the silver/chrome pixels (where r~g~b), but keep the red/fiery flame
            is_fiery = (r > 100 and r > g * 1.3) or (r > 150 and g > 80 and b < 80)
            if is_fiery:
                # Keep flame red/orange
                out_light.append((r, g, b, alpha))
            else:
                # Darken chrome to deep gunmetal/black for light backgrounds
                dark_r = int(255 - r * 0.85)
                dark_g = int(255 - g * 0.85)
                dark_b = int(255 - b * 0.85)
                out_light.append((dark_r, dark_g, dark_b, alpha))
                
    img_dark = Image.new('RGBA', (w, h))
    img_dark.putdata(out_dark)
    
    img_light = Image.new('RGBA', (w, h))
    img_light.putdata(out_light)
    
    return img_dark, img_light

def main():
    src_path = 'C:/Users/kage/.gemini/antigravity/brain/332e3e1e-2717-4d4d-9aad-22651af45bfb/.user_uploaded/media_1793485341324_269bf426.jpg'
    logo_img = Image.open(src_path)
    
    out_dir = 'apps/web/public/brand'
    os.makedirs(out_dir, exist_ok=True)
    
    # 1. Full Lockup 'DOSCO TEK'
    # bbox (95, 180, 925, 360)
    wordmark_box = (90, 180, 925, 360)
    crop_wordmark = logo_img.crop(wordmark_box)
    wm_dark, wm_light = extract_with_screen_blend(crop_wordmark)
    wm_dark.save(os.path.join(out_dir, 'dosco-wordmark-dark.png'), 'PNG')
    wm_light.save(os.path.join(out_dir, 'dosco-wordmark-light.png'), 'PNG')
    print('Saved wordmarks!')
    
    # 2. Icon (Fiery K)
    # bbox (720, 185, 920, 340)
    icon_box = (720, 180, 920, 340)
    crop_icon = logo_img.crop(icon_box)
    icon_dark, icon_light = extract_with_screen_blend(crop_icon)
    icon_dark.save(os.path.join(out_dir, 'dosco-icon-dark.png'), 'PNG')
    icon_light.save(os.path.join(out_dir, 'dosco-icon-light.png'), 'PNG')
    print('Saved icons!')
    
    # 3. Crest (Icon used in BreathingCrest)
    icon_dark.save(os.path.join(out_dir, 'dosco-crest.png'), 'PNG')
    print('Saved dosco-crest.png!')

if __name__ == '__main__':
    main()
