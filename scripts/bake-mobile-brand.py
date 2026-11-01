import os
import math
from PIL import Image, ImageOps

CREST_SRC = 'C:/Users/kage/.gemini/antigravity/brain/332e3e1e-2717-4d4d-9aad-22651af45bfb/.user_uploaded/media_1793488983849_39c431ef.png'
WORDMARK_SRC = 'C:/Users/kage/.gemini/antigravity/brain/332e3e1e-2717-4d4d-9aad-22651af45bfb/.user_uploaded/media_1793489016010_abff4421.png'

MOBILE_BRAND = 'apps/mobile/assets/brand'
MOBILE_IMG = 'apps/mobile/assets/images'
ANDROID_RES = 'apps/mobile/android/app/src/main/res'

def transparent_from_black(img, bg_thresh=8, is_wordmark=False):
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
                alpha = min(255, int(255 * ((v - bg_thresh) / (255.0 - bg_thresh)) ** 0.85 * 1.15))
                scale = 255.0 / max(1, v)
                nr = min(255, int(r * scale))
                ng = min(255, int(g * scale))
                nb = min(255, int(b * scale))
                
                dst_d[x, y] = (nr, ng, nb, alpha)
                
                is_fiery = (r > 100 and r > g * 1.35) or (x > 750 and is_wordmark and r > 120 and r > g * 1.2)
                
                if is_fiery or not is_wordmark:
                    dst_l[x, y] = (nr, ng, nb, alpha)
                else:
                    lum = int(0.299 * nr + 0.587 * ng + 0.114 * nb)
                    dark_val = int(20 + (255 - lum) * 0.45)
                    dst_l[x, y] = (dark_val, dark_val, int(dark_val * 1.05), alpha)
                    
    return out_dark, out_light

def white_silhouette(img):
    out = Image.new('RGBA', img.size)
    src = img.load()
    dst = out.load()
    for y in range(img.height):
        for x in range(img.width):
            _, _, _, a = src[x, y]
            dst[x, y] = (255, 255, 255, a)
    return out

def fit_on_square(img, size, scale=0.85, bg=None):
    canvas = Image.new('RGBA', (size, size), bg if bg else (0, 0, 0, 0))
    target_dim = int(size * scale)
    w, h = img.size
    aspect = w / h
    if aspect >= 1:
        tw = target_dim
        th = int(target_dim / aspect)
    else:
        th = target_dim
        tw = int(target_dim * aspect)
    
    resized = img.resize((tw, th), Image.Resampling.LANCZOS)
    x = (size - tw) // 2
    y = (size - th) // 2
    canvas.paste(resized, (x, y), resized)
    return canvas

def fit_in_box(img, target_w, target_h, scale=0.92):
    canvas = Image.new('RGBA', (target_w, target_h), (0, 0, 0, 0))
    max_w = int(target_w * scale)
    max_h = int(target_h * scale)
    
    w, h = img.size
    ratio = min(max_w / w, max_h / h)
    tw = int(w * ratio)
    th = int(h * ratio)
    
    resized = img.resize((tw, th), Image.Resampling.LANCZOS)
    x = (target_w - tw) // 2
    y = (target_h - th) // 2
    canvas.paste(resized, (x, y), resized)
    return canvas

def circle_mask(size):
    mask = Image.new('L', (size, size), 0)
    from PIL import ImageDraw
    draw = ImageDraw.Draw(mask)
    draw.ellipse((0, 0, size - 1, size - 1), fill=255)
    return mask

def main():
    os.makedirs(MOBILE_BRAND, exist_ok=True)
    os.makedirs(MOBILE_IMG, exist_ok=True)
    
    # Process crest
    im_c = Image.open(CREST_SRC)
    c_dark, c_light = transparent_from_black(im_c, bg_thresh=10, is_wordmark=False)
    bbox_c = c_dark.getbbox()
    c_cropped = c_dark.crop(bbox_c)
    
    # 1. Square crest (1024x1024)
    crest_square = fit_on_square(c_cropped, 1024, scale=0.92)
    crest_square.save(os.path.join(MOBILE_BRAND, 'dosco-crest-square.png'), 'PNG')
    crest_square.save(os.path.join(MOBILE_BRAND, 'dosco-crest.png'), 'PNG')
    
    # 2. Loader crest (480x480 square)
    crest_loader = fit_on_square(c_cropped, 480, scale=0.92)
    crest_loader.save(os.path.join(MOBILE_BRAND, 'dosco-crest-loader.png'), 'PNG')
    
    with open(os.path.join(MOBILE_BRAND, 'dosco-crest-ratio.txt'), 'w', encoding='utf-8') as f:
        f.write('1.0000')
        
    # 3. Crest silhouette (1024x1024)
    crest_sil = white_silhouette(crest_square)
    crest_sil.save(os.path.join(MOBILE_BRAND, 'dosco-crest-silhouette.png'), 'PNG')
    
    # 4. Wordmarks (1600x342 canvas to match KortixLogo test & ratio 1600/342)
    im_wm = Image.open(WORDMARK_SRC)
    wm_dark_raw, wm_light_raw = transparent_from_black(im_wm, bg_thresh=10, is_wordmark=True)
    bbox_wm = wm_dark_raw.getbbox()
    wm_dark_crop = wm_dark_raw.crop(bbox_wm)
    wm_light_crop = wm_light_raw.crop(bbox_wm)
    
    wm_dark_1600 = fit_in_box(wm_light_crop, 1600, 342, scale=0.92)  # dark ink for light surface
    wm_light_1600 = fit_in_box(wm_dark_crop, 1600, 342, scale=0.92) # light ink for dark surface
    
    wm_dark_1600.save(os.path.join(MOBILE_BRAND, 'dosco-wordmark-dark.png'), 'PNG')
    wm_light_1600.save(os.path.join(MOBILE_BRAND, 'dosco-wordmark-light.png'), 'PNG')
    
    with open(os.path.join(MOBILE_BRAND, 'dosco-wordmark-ratio.txt'), 'w', encoding='utf-8') as f:
        f.write(f'{(1600.0/342.0):.4f}')
        
    print('Baked mobile brand assets.')
    
    # 5. Mobile App Icons and Splash
    BLACK_BG = (12, 12, 12, 255)
    
    # AppIcon-Light.png (2048x2048, solid black background, crest at 80%)
    app_icon = fit_on_square(c_cropped, 2048, scale=0.80, bg=BLACK_BG)
    app_icon.save(os.path.join(MOBILE_IMG, 'AppIcon-Light.png'), 'PNG')
    
    # adaptive-icon.png (1024x1024, transparent background, crest at 72%)
    adaptive_icon = fit_on_square(c_cropped, 1024, scale=0.72)
    adaptive_icon.save(os.path.join(MOBILE_IMG, 'adaptive-icon.png'), 'PNG')
    
    # splash.png (2048x2048, solid black background, crest at 70%)
    splash = fit_on_square(c_cropped, 2048, scale=0.70, bg=(0, 0, 0, 255))
    splash.save(os.path.join(MOBILE_IMG, 'splash.png'), 'PNG')
    
    # notification-icon.png (96x96, white silhouette, scale 0.8)
    notif_icon = fit_on_square(white_silhouette(c_cropped), 96, scale=0.8)
    notif_icon.save(os.path.join(MOBILE_IMG, 'notification-icon.png'), 'PNG')
    
    # favicon.png (48x48)
    fav = fit_on_square(c_cropped, 48, scale=0.88)
    fav.save(os.path.join(MOBILE_IMG, 'favicon.png'), 'PNG')
    
    print('Baked mobile app images.')
    
    # 6. Android res mipmaps and drawables
    launcher_sizes = {'mdpi': 48, 'hdpi': 72, 'xhdpi': 96, 'xxhdpi': 144, 'xxxhdpi': 192}
    fg_sizes = {'mdpi': 108, 'hdpi': 162, 'xhdpi': 216, 'xxhdpi': 324, 'xxxhdpi': 432}
    notif_sizes = {'mdpi': 24, 'hdpi': 36, 'xhdpi': 48, 'xxhdpi': 72, 'xxxhdpi': 96}
    splash_sizes = {'mdpi': 240, 'hdpi': 360, 'xhdpi': 480, 'xxhdpi': 720, 'xxxhdpi': 960}
    
    for dpi, size in launcher_sizes.items():
        d = os.path.join(ANDROID_RES, f'mipmap-{dpi}')
        os.makedirs(d, exist_ok=True)
        # square icon
        sq = fit_on_square(c_cropped, size, scale=0.85, bg=BLACK_BG)
        sq.save(os.path.join(d, 'ic_launcher.webp'), 'WEBP')
        
        # round icon
        mask = circle_mask(size)
        sq_round = sq.copy()
        sq_round.putalpha(mask)
        sq_round.save(os.path.join(d, 'ic_launcher_round.webp'), 'WEBP')
        
        # foreground
        fg = fit_on_square(c_cropped, fg_sizes[dpi], scale=0.72)
        fg.save(os.path.join(d, 'ic_launcher_foreground.webp'), 'WEBP')
        
    for dpi, size in notif_sizes.items():
        d = os.path.join(ANDROID_RES, f'drawable-{dpi}')
        os.makedirs(d, exist_ok=True)
        ni = fit_on_square(white_silhouette(c_cropped), size, scale=0.8)
        ni.save(os.path.join(d, 'notification_icon.png'), 'PNG')
        
    for dpi, size in splash_sizes.items():
        d = os.path.join(ANDROID_RES, f'drawable-{dpi}')
        os.makedirs(d, exist_ok=True)
        sp = fit_on_square(c_cropped, size, scale=0.70, bg=(0, 0, 0, 255))
        sp.save(os.path.join(d, 'splashscreen_logo.png'), 'PNG')
        
    print('Baked android res images.')

if __name__ == '__main__':
    main()
