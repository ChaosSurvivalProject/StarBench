/* StarBench Web — 程序化贴图（完全自产，无官方美术资源）
 * 在离屏 canvas 上用确定性噪声绘制 4x3 图集。
 */
(function (global) {
  "use strict";
  const SB = (global.SB = global.SB || {});

  function h2(x, y, s) {
    let n = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(s | 0, 1442695041);
    n = Math.imul(n ^ (n >>> 13), 1274126177);
    return ((n ^ (n >>> 16)) >>> 0) / 4294967295;
  }

  // 每种瓦片的基色与绘制规则
  const TILE_STYLE = {
    0: { name: 'grass_top', base: [106, 168, 74], grain: 34, speckle: true },
    1: { name: 'grass_side', base: [124, 96, 60], grain: 30, topBand: [106, 168, 74] },
    2: { name: 'dirt', base: [134, 96, 62], grain: 36, speckle: true },
    3: { name: 'stone', base: [126, 130, 134], grain: 28, cracks: true },
    4: { name: 'wood_top', base: [154, 118, 74], grain: 22, rings: true },
    5: { name: 'wood_side', base: [138, 104, 64], grain: 26, stripes: true },
    6: { name: 'leaves', base: [72, 142, 68], grain: 48, speckle: true },
    7: { name: 'water', base: [56, 112, 188], grain: 22, ripple: true },
    8: { name: 'sand', base: [214, 198, 142], grain: 26, speckle: true },
  };

  function buildAtlas() {
    const cols = SB.ATLAS_COLS, rows = SB.ATLAS_ROWS, T = 16;
    const cv = document.createElement('canvas');
    cv.width = cols * T; cv.height = rows * T;
    const ctx = cv.getContext('2d');
    for (let tile = 0; tile < cols * rows; tile++) {
      const col = tile % cols, row = Math.floor(tile / cols);
      const ox = col * T, oy = row * T;
      const st = TILE_STYLE[tile];
      const img = ctx.createImageData(T, T);
      for (let y = 0; y < T; y++) {
        for (let x = 0; x < T; x++) {
          let r, g, b;
          if (!st) { r = 200; g = 60; b = 200; }
          else {
            const n = h2(x, y, tile * 7919);
            const n2 = h2(x >> 1, y >> 1, tile * 104729);
            let d = (n - 0.5) * st.grain + (n2 - 0.5) * st.grain * 0.5;
            r = st.base[0] + d; g = st.base[1] + d; b = st.base[2] + d;
            if (st.topBand && y <= 3) { r = st.topBand[0] + d * 0.6; g = st.topBand[1] + d * 0.6; b = st.topBand[2] + d * 0.6; }
            if (st.rings) { const rr = Math.sqrt((x-7.5)**2+(y-7.5)**2); const band = Math.sin(rr*2.2)*8; r+=band;g+=band;b+=band*0.5; }
            if (st.stripes) { const band = Math.sin(x*1.7)*9; r+=band;g+=band;b+=band*0.4; }
            if (st.cracks && (n2 > 0.93 || (x+y)%13===0)) { r*=0.7;g*=0.7;b*=0.7; }
            if (st.ripple) { const band = Math.sin((x+y)*0.9)*10; r+=band*0.3;g+=band*0.6;b+=band; }
            if (st.speckle && n > 0.94) { r*=1.15;g*=1.15;b*=1.15; }
          }
          const p = (y * T + x) * 4;
          img.data[p] = Math.max(0, Math.min(255, r));
          img.data[p + 1] = Math.max(0, Math.min(255, g));
          img.data[p + 2] = Math.max(0, Math.min(255, b));
          img.data[p + 3] = 255;
        }
      }
      ctx.putImageData(img, ox, oy);
    }
    return cv;
  }
  SB.buildAtlas = buildAtlas;
})(typeof window !== "undefined" ? window : globalThis);
