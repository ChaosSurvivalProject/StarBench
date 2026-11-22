/* StarBench Web — Faithful 64x 贴图加载
 * 使用 Faithful Resource Pack 的 64×64 方块贴图（开源，见 THIRD_PARTY_LICENSES.txt）。
 * 图集由 faithfulpack 官方贴图烘焙而成；草/叶/水按 Minecraft 生物群系 colormap 着色。
 * 图片异步加载，加载完成后通过 SB.onAtlasReady 回调通知渲染器重新上传纹理。
 */
(function (global) {
  "use strict";
  const SB = (global.SB = global.SB || {});

  const T = 64;
  const COLS = SB.ATLAS_COLS || 4;
  const ROWS = SB.ATLAS_ROWS || 3;

  SB.atlasReady = false;
  SB.onAtlasReady = null;

  function buildAtlas() {
    const cv = document.createElement("canvas");
    cv.width = COLS * T;
    cv.height = ROWS * T;
    const ctx = cv.getContext("2d");
    // 加载前的中性占位，避免首帧全黑
    ctx.fillStyle = "#7d8790";
    ctx.fillRect(0, 0, cv.width, cv.height);
    const img = new Image();
    img.onload = function () {
      ctx.clearRect(0, 0, cv.width, cv.height);
      ctx.drawImage(img, 0, 0, cv.width, cv.height);
      SB.atlasReady = true;
      if (typeof SB.onAtlasReady === "function") SB.onAtlasReady();
    };
    img.onerror = function () {
      // 贴图缺失时保留占位色，保证跑分仍可进行（诚实标注在 README）
      SB.atlasReady = false;
    };
    img.src = "textures/atlas64.png";
    return cv;
  }
  SB.buildAtlas = buildAtlas;

  // 动物图集：来自 22i/minecraft-voxel-blender-models（GPL-3.0）的 6 张 64×32 UV 贴图烘焙
  const MW = 64, MH = 32, MCOLS = SB.MOB_ATLAS_COLS || 4, MROWS = SB.MOB_ATLAS_ROWS || 2;
  SB.mobAtlasReady = false;
  SB.onMobAtlasReady = null;
  function buildMobAtlas() {
    const cv = document.createElement("canvas");
    cv.width = MCOLS * MW; cv.height = MROWS * MH;
    const ctx = cv.getContext("2d");
    ctx.fillStyle = "#8899aa";
    ctx.fillRect(0, 0, cv.width, cv.height);
    const img = new Image();
    img.onload = function () {
      ctx.clearRect(0, 0, cv.width, cv.height);
      ctx.drawImage(img, 0, 0, cv.width, cv.height);
      SB.mobAtlasReady = true;
      if (typeof SB.onMobAtlasReady === "function") SB.onMobAtlasReady();
    };
    img.onerror = function () { SB.mobAtlasReady = false; };
    img.src = "textures/mobatlas.png";
    return cv;
  }
  SB.buildMobAtlas = buildMobAtlas;
})(typeof window !== "undefined" ? window : globalThis);
