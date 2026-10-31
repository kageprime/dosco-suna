import sys
from PIL import Image, ImageSequence

src_path = "C:/Users/kage/Pictures/Fiery_red_K_logo_loading_1ed593f5.gif"
im = Image.open(src_path)

frames = []
durations = []

# Crop box: 260x260 centered on flame
CROP_BOX = (102, 5, 362, 265)
CROP_W = CROP_BOX[2] - CROP_BOX[0]
CROP_H = CROP_BOX[3] - CROP_BOX[1]

print(f"Processing {im.n_frames} frames with chroma-key and square crop...")

# We can step by 1 or 2. If n_frames = 160, step 2 gives 80 frames at 50fps, or step 1 gives 160 frames.
# Step 1 preserves the complete full animation.
step = 1 if im.n_frames <= 100 else 2

for idx in range(0, im.n_frames, step):
    im.seek(idx)
    dur = im.info.get('duration', 30) * step
    durations.append(dur)
    
    # Crop first, then chroma key to be 2.5x faster
    cropped = im.crop(CROP_BOX).convert('RGB')
    w, h = cropped.size
    
    raw = cropped.tobytes()
    out = bytearray(w * h * 4)
    
    for i in range(w * h):
        r = raw[i * 3]
        g = raw[i * 3 + 1]
        b = raw[i * 3 + 2]
        
        # Color difference keying
        k = max(r, b)
        diff = g - k
        
        if diff > 18:
            # Pure green background
            out[i * 4] = 0
            out[i * 4 + 1] = 0
            out[i * 4 + 2] = 0
            out[i * 4 + 3] = 0
        elif diff > 0:
            # Feather edge: ramp alpha from 0 to 255
            alpha = int(255 * (1.0 - diff / 18.0))
            # Desaturate green spill: clamp g to k
            g_clean = min(g, k)
            out[i * 4] = r
            out[i * 4 + 1] = g_clean
            out[i * 4 + 2] = b
            out[i * 4 + 3] = alpha
        else:
            # Foreground (red flame, sparks, glow)
            # Remove any subtle green cast if g > 1.2 * k
            out[i * 4] = r
            out[i * 4 + 1] = g
            out[i * 4 + 2] = b
            out[i * 4 + 3] = 255
            
    rgba_img = Image.frombytes('RGBA', (w, h), bytes(out))
    frames.append(rgba_img)

print(f"Processed {len(frames)} frames. Saving webp...")

frames[0].save(
    "apps/web/public/brand/dosco-loader.webp",
    save_all=True,
    append_images=frames[1:],
    duration=durations,
    loop=0,
    lossless=False,
    quality=90,
    method=4,
)

print("Saved apps/web/public/brand/dosco-loader.webp!")
