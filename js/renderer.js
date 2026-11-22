/* StarBench Web — WebGL 渲染器 v0.5
 *
 * - WebGL2 优先，失败回退 WebGL1（同一套 GLSL ES 1.00 着色器，两者兼容）。
 * - 固定 drawing buffer + render scale：lockBuffer() 后 resize 不漂移，采样期间不随窗口/DPR 变化。
 * - 固定相机路径：每个场景由世界尺寸确定性推导的静态机位，无自动旋转、无交互改变负载。
 * - 预分配帧时间曲线缓冲；渲染提交耗时单独计时（模块 7）。
 * - 地形 + 动物两套程序；Faithful 64x 方块图集 / 22i 动物图集。
 * - 离屏 WebGL → 可见 2D 画布，规避部分浏览器 WebGL 合成层问题。
 */
(function (global) {
  "use strict";
  const SB = (global.SB = global.SB || {});

  const M4 = {
    identity: () => new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]),
    perspective(fovy, aspect, near, far) {
      const f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far);
      return new Float32Array([
        f/aspect,0,0,0, 0,f,0,0, 0,0,(far+near)*nf,-1, 0,0,2*far*near*nf,0,
      ]);
    },
    lookAt(eye, center, up) {
      let zx=eye[0]-center[0], zy=eye[1]-center[1], zz=eye[2]-center[2];
      let l=Math.hypot(zx,zy,zz)||1; zx/=l;zy/=l;zz/=l;
      let xx=up[1]*zz-up[2]*zy, xy=up[2]*zx-up[0]*zz, xz=up[0]*zy-up[1]*zx;
      l=Math.hypot(xx,xy,xz)||1; xx/=l;xy/=l;xz/=l;
      const yx=zy*xz-zz*xy, yy=zz*xx-zx*xz, yz=zx*xy-zy*xx;
      return new Float32Array([
        xx,yx,zx,0, xy,yy,zy,0, xz,yz,zz,0,
        -(xx*eye[0]+xy*eye[1]+xz*eye[2]), -(yx*eye[0]+yy*eye[1]+yz*eye[2]), -(zx*eye[0]+zy*eye[1]+zz*eye[2]), 1,
      ]);
    },
    mul(a, b) {
      const o = new Float32Array(16);
      for (let c=0;c<4;c++) for (let r=0;r<4;r++) {
        o[c*4+r]=a[r]*b[c*4]+a[4+r]*b[c*4+1]+a[8+r]*b[c*4+2]+a[12+r]*b[c*4+3];
      }
      return o;
    },
    model(x, y, z, yaw, bob, s) {
      s = s || 1;
      const cy=Math.cos(yaw)*s, sy=Math.sin(yaw)*s;
      return new Float32Array([
        cy,0,-sy,0, 0,s,0,0, sy,0,cy,0, x,y+bob,z,1,
      ]);
    },
  };

  const VS = `
    attribute vec3 aPos; attribute vec2 aUV; attribute float aLight;
    uniform mat4 uMVP; uniform vec3 uEye;
    varying vec2 vUV; varying float vLight; varying float vDist;
    void main() {
      vUV=aUV; vLight=aLight; vDist=distance(aPos,uEye);
      gl_Position=uMVP*vec4(aPos,1.0);
    }`;
  const FS = `
    precision mediump float;
    uniform sampler2D uTex; uniform vec3 uFog; uniform float uFogNear; uniform float uFogFar;
    varying vec2 vUV; varying float vLight; varying float vDist;
    void main() {
      vec4 tex=texture2D(uTex,vUV);
      if (tex.a<0.5) discard;
      vec3 col=tex.rgb*(0.25+0.75*vLight);
      float f=clamp((vDist-uFogNear)/(uFogFar-uFogNear),0.0,1.0);
      gl_FragColor=vec4(mix(col,uFog,f),1.0);
    }`;
  const MVS = `
    attribute vec3 aPos; attribute vec2 aUV; attribute float aShade;
    uniform mat4 uMVP; uniform mat4 uModel; uniform vec3 uEye;
    varying vec2 vUV; varying float vShade; varying float vDist;
    void main() {
      vec4 wp=uModel*vec4(aPos,1.0);
      vUV=aUV; vShade=aShade; vDist=distance(wp.xyz,uEye);
      gl_Position=uMVP*wp;
    }`;
  const MFS = `
    precision mediump float;
    uniform sampler2D uTex; uniform vec3 uFog; uniform float uFogNear; uniform float uFogFar;
    varying vec2 vUV; varying float vShade; varying float vDist;
    void main() {
      vec4 tex=texture2D(uTex,vUV);
      if (tex.a<0.5) discard;
      vec3 col=tex.rgb*vShade;
      float f=clamp((vDist-uFogNear)/(uFogFar-uFogNear),0.0,1.0);
      gl_FragColor=vec4(mix(col,uFog,f),1.0);
    }`;

  function compile(gl, type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  }
  function program(gl, vs, fs, attrs, unis) {
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
    gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    const a={}, u={};
    for (const [name, alias] of attrs) a[alias]=gl.getAttribLocation(p,name);
    for (const [name, alias] of unis) u[alias]=gl.getUniformLocation(p,name);
    return { p, a, u };
  }
  function makeTexture(gl, source, atlasCanvas) {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }

  class WebGLRenderer {
    constructor(glCanvas, screenCanvas) {
      this.canvas = glCanvas;
      this.screen = screenCanvas;
      this.screenCtx = screenCanvas ? screenCanvas.getContext("2d") : null;
      // WebGL2 优先，失败回退 WebGL1
      const opts = { antialias: true, alpha: false, preserveDrawingBuffer: true, powerPreference: "high-performance" };
      let gl = glCanvas.getContext("webgl2", opts);
      this.api = gl ? "WebGL2" : "WebGL1";
      if (!gl) gl = glCanvas.getContext("webgl", opts) || glCanvas.getContext("experimental-webgl", opts);
      if (!gl) throw new Error("WebGL 不可用（WebGL2/WebGL1 均无法创建上下文）");
      this.gl = gl;

      this._initGL();

      this.vertexCount = 0;
      this.worldCenter = [0, 0, 0];
      this.radius = 24;
      this.groundY = 8;
      this.entityRef = [];
      this.locked = false;
      this.renderScale = 1.0;
      this.curveBuf = new Float32Array(256); // 预分配帧时间曲线（5Hz 更新）
      this.curveIdx = 0;
      this.submitBuf = new Float32Array(256); // 渲染提交耗时环形缓冲
      this.submitIdx = 0;
      this.reducedMotion = !!(global.matchMedia && global.matchMedia("(prefers-reduced-motion: reduce)").matches);
      // 初始 buffer（未锁定）
      this.resize();
    }

    _initGL() {
      const gl = this.gl;
      this.terrain = program(gl, VS, FS,
        [["aPos","pos"],["aUV","uv"],["aLight","light"]],
        [["uMVP","mvp"],["uEye","eye"],["uTex","tex"],["uFog","fog"],["uFogNear","fogNear"],["uFogFar","fogFar"]]);
      this.mob = program(gl, MVS, MFS,
        [["aPos","pos"],["aUV","uv"],["aShade","shade"]],
        [["uMVP","mvp"],["uModel","model"],["uEye","eye"],["uTex","tex"],["uFog","fog"],["uFogNear","fogNear"],["uFogFar","fogFar"]]);
      this.buf = { pos: gl.createBuffer(), uv: gl.createBuffer(), light: gl.createBuffer() };
      const atlas = SB.buildAtlas();
      this.atlasCanvas = atlas;
      this.tex = makeTexture(gl, atlas, atlas);
      this._atlasReady = false;
      const self = this;
      SB.onAtlasReady = function () { self._atlasReady = true; self.refreshTexture(); };
      const mobAtlas = SB.buildMobAtlas();
      this.mobAtlasCanvas = mobAtlas;
      this.mobTex = makeTexture(gl, mobAtlas, mobAtlas);
      this._mobAtlasReady = false;
      SB.onMobAtlasReady = function () { self._mobAtlasReady = true; self.refreshMobTexture(); };
      this.mobGeo = this._buildMobGeometry();
      this.mobBuf = { pos: gl.createBuffer(), uv: gl.createBuffer(), shade: gl.createBuffer(), idx: gl.createBuffer() };
      gl.enable(gl.DEPTH_TEST);
      gl.enable(gl.CULL_FACE);
      gl.cullFace(gl.BACK);
      // atlas 图片异步就绪后刷新纹理（轮询，不依赖回调时序）
      this._texWait = 0;
    }

    rebuild() {
      // WebGL contextrestored 后重建全部 GPU 资源
      this._initGL();
      if (this._lastMesh) this.uploadMesh(this._lastMesh);
      if (this._atlasReady) this.refreshTexture();
      if (this._mobAtlasReady) this.refreshMobTexture();
      this.resize();
    }

    refreshTexture() {
      const gl = this.gl;
      gl.bindTexture(gl.TEXTURE_2D, this.tex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.atlasCanvas);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    }
    refreshMobTexture() {
      const gl = this.gl;
      gl.bindTexture(gl.TEXTURE_2D, this.mobTex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.mobAtlasCanvas);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    }

    _buildMobGeometry() {
      const C = SB.MOB_ATLAS_COLS, R = SB.MOB_ATLAS_ROWS;
      const out = {};
      for (const name of Object.keys(SB.MOB_MODELS || {})) {
        const m = SB.MOB_MODELS[name];
        const pos=[], uv=[], shade=[], idx=[]; let base=0;
        for (const part of m.parts) {
          const col=part.tile % C, row=Math.floor(part.tile / C);
          for (let i=0;i<part.pos.length;i+=3) {
            pos.push(part.pos[i]*m.scale, part.pos[i+1]*m.scale, part.pos[i+2]*m.scale);
            const ny = part.pos[i+1] / 5;
            shade.push(0.62 + 0.38 * Math.max(0, Math.min(1, 0.5 + ny)));
          }
          for (let i=0;i<part.uv.length;i+=2) uv.push((col+part.uv[i])/C, 1-(row+part.uv[i+1])/R);
          for (const ix of part.idx) idx.push(ix+base);
          base += part.pos.length/3;
        }
        out[name] = { pos:new Float32Array(pos), uv:new Float32Array(uv), shade:new Float32Array(shade), idx:new Uint16Array(idx) };
      }
      return out;
    }

    // 锁定 drawing buffer：采样期间尺寸/DPR 不漂移
    lockBuffer() {
      const ref = this.screen || this.canvas;
      const dpr = Math.min(global.devicePixelRatio || 1, 2);
      const maxSize = this.gl.getParameter(this.gl.MAX_TEXTURE_SIZE) || 4096;
      let w = Math.floor((ref.clientWidth || 1280) * dpr * this.renderScale);
      let h = Math.floor((ref.clientHeight || 720) * dpr * this.renderScale);
      w = Math.max(1, Math.min(maxSize, w));
      h = Math.max(1, Math.min(maxSize, h));
      this.canvas.width = w; this.canvas.height = h;
      if (this.screen) { this.screen.width = w; this.screen.height = h; }
      this.gl.viewport(0, 0, w, h);
      this.locked = true;
      this._lockedSize = { w, h };
    }
    unlockBuffer() { this.locked = false; }
    bufferSize() { return this._lockedSize || { w: this.canvas.width, h: this.canvas.height }; }

    resize() {
      if (this.locked) return; // 采样期间尺寸锁定，resize 不生效
      const c = this.canvas;
      const dpr = Math.min(global.devicePixelRatio || 1, 2);
      const ref = this.screen || c;
      const w = Math.max(1, Math.floor((ref.clientWidth || 1280) * dpr));
      const h = Math.max(1, Math.floor((ref.clientHeight || 720) * dpr));
      if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
      this.gl.viewport(0, 0, c.width, c.height);
      if (this.screen && (this.screen.width !== c.width || this.screen.height !== c.height)) {
        this.screen.width = c.width; this.screen.height = c.height;
      }
    }

    // 接收 Worker 传来的网格（transferable 已复制到新数组）
    uploadMesh(d) {
      const gl = this.gl;
      const m = {
        position: d.position instanceof Float32Array ? d.position : new Float32Array(d.position),
        uv: d.uv instanceof Float32Array ? d.uv : new Float32Array(d.uv),
        light: d.light instanceof Float32Array ? d.light : new Float32Array(d.light),
        vertexCount: d.vertexCount,
      };
      this._lastMesh = m;
      this.vertexCount = m.vertexCount;
      const bind = (buf, arr, loc, size) => {
        gl.bindBuffer(gl.ARRAY_BUFFER, buf);
        gl.bufferData(gl.ARRAY_BUFFER, arr, gl.STATIC_DRAW);
        gl.enableVertexAttribArray(loc);
        gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
      };
      bind(this.buf.pos, m.position, this.terrain.a.pos, 3);
      bind(this.buf.uv, m.uv, this.terrain.a.uv, 2);
      bind(this.buf.light, m.light, this.terrain.a.light, 1);
    }

    // 从 world 尺寸确定性推导静态机位（无自动旋转、无交互改变负载）
    setWorldMeta(sx, sz, h, surfaceSample, entities) {
      this.worldCenter = [(sx - 1) / 2, h * 0.35, (sz - 1) / 2];
      this.radius = Math.max(sx, sz) * 0.72;
      this.groundY = surfaceSample || h * 0.3;
      this.entityRef = entities || [];
      // 固定机位：以种子无关的确定性角度俯视中央空地
      const ang = 0.72; // 固定方位角，每次运行一致
      const camR = this.radius * 0.62;
      this._eye = [
        this.worldCenter[0] + Math.cos(ang) * camR,
        this.groundY + (this.reducedMotion ? 5 : 6),
        this.worldCenter[2] + Math.sin(ang) * camR,
      ];
      this._lookAt = [this.worldCenter[0], this.groundY + 1.5, this.worldCenter[2]];
    }

    setEntities(entities) { this.entityRef = entities || []; }

    addFrameSample(ms) {
      this.curveBuf[this.curveIdx] = ms;
      this.curveIdx = (this.curveIdx + 1) % this.curveBuf.length;
    }
    curveSnapshot() {
      const out = [];
      for (let k = 0; k < this.curveBuf.length; k++) out.push(this.curveBuf[(this.curveIdx + k) % this.curveBuf.length]);
      return out;
    }
    avgSubmitMs() {
      let s = 0; for (const v of this.submitBuf) s += v;
      return this.submitBuf.length ? s / this.submitBuf.length : 0;
    }

    draw() {
      const gl = this.gl, c = this.canvas;
      const t0 = performance.now();
      if (this._texWait < 240) { this._texWait++; if (this._atlasReady) this.refreshTexture(); if (this._mobAtlasReady) this.refreshMobTexture(); }
      this.resize();

      const eye = this._eye || [0, 20, 40];
      const lookAt = this._lookAt || [0, 8, 0];
      const R = this.radius || 24;
      const proj = M4.perspective(50 * Math.PI/180, c.width/c.height, 0.1, R*4+400);
      const view = M4.lookAt(eye, lookAt, [0,1,0]);
      const mvp = M4.mul(proj, view);
      const fogNear=R*0.75, fogFar=R*2.0, fog=[0.62,0.76,0.90];

      gl.clearColor(0.62,0.76,0.90,1);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

      // ---- 地形 ----
      gl.useProgram(this.terrain.p);
      const T=this.terrain;
      gl.uniformMatrix4fv(T.u.mvp,false,mvp); gl.uniform3fv(T.u.eye,eye);
      gl.uniform3fv(T.u.fog,fog); gl.uniform1f(T.u.fogNear,fogNear); gl.uniform1f(T.u.fogFar,fogFar);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D,this.tex); gl.uniform1i(T.u.tex,0);
      gl.bindBuffer(gl.ARRAY_BUFFER,this.buf.pos); gl.vertexAttribPointer(T.a.pos,3,gl.FLOAT,false,0,0); gl.enableVertexAttribArray(T.a.pos);
      gl.bindBuffer(gl.ARRAY_BUFFER,this.buf.uv); gl.vertexAttribPointer(T.a.uv,2,gl.FLOAT,false,0,0); gl.enableVertexAttribArray(T.a.uv);
      gl.bindBuffer(gl.ARRAY_BUFFER,this.buf.light); gl.vertexAttribPointer(T.a.light,1,gl.FLOAT,false,0,0); gl.enableVertexAttribArray(T.a.light);
      if (this.vertexCount>0) gl.drawArrays(gl.TRIANGLES,0,this.vertexCount);

      // ---- 动物（视图剔除：视野外不绘制；reduced-motion 关闭步态抖动）----
      if (this.entityRef && this.entityRef.length) {
        gl.useProgram(this.mob.p);
        const M=this.mob;
        gl.uniformMatrix4fv(M.u.mvp,false,mvp); gl.uniform3fv(M.u.eye,eye);
        gl.uniform3fv(M.u.fog,fog); gl.uniform1f(M.u.fogNear,fogNear); gl.uniform1f(M.u.fogFar,fogFar);
        gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D,this.mobTex); gl.uniform1i(M.u.tex,0);
        let curType=null;
        const viewR = R * 1.6;
        for (const e of this.entityRef) {
          const dx=e.x-eye[0], dz=e.z-eye[2];
          if (dx*dx+dz*dz > viewR*viewR) continue; // 视锥/距离剔除
          const g=this.mobGeo[e.type]; if (!g) continue;
          if (curType!==e.type) { this._uploadMobGeo(g); curType=e.type; }
          const bob=this.reducedMotion ? 0 : Math.abs(Math.sin(e.legPhase||0))*0.06;
          gl.uniformMatrix4fv(M.u.model,false,M4.model(e.x,e.y,e.z,e.yaw||0,bob,2.0));
          gl.drawElements(gl.TRIANGLES,g.idx.length,gl.UNSIGNED_SHORT,0);
        }
      }

      if (this.screenCtx) this.screenCtx.drawImage(c, 0, 0);
      // 渲染提交耗时计时（模块 7，诊断用）
      this.submitBuf[this.submitIdx] = performance.now() - t0;
      this.submitIdx = (this.submitIdx + 1) % this.submitBuf.length;
    }

    _uploadMobGeo(g) {
      const gl=this.gl, mb=this.mobBuf, a=this.mob.a;
      gl.bindBuffer(gl.ARRAY_BUFFER, mb.pos); gl.bufferData(gl.ARRAY_BUFFER,g.pos,gl.STATIC_DRAW); gl.enableVertexAttribArray(a.pos); gl.vertexAttribPointer(a.pos,3,gl.FLOAT,false,0,0);
      gl.bindBuffer(gl.ARRAY_BUFFER, mb.uv); gl.bufferData(gl.ARRAY_BUFFER,g.uv,gl.STATIC_DRAW); gl.enableVertexAttribArray(a.uv); gl.vertexAttribPointer(a.uv,2,gl.FLOAT,false,0,0);
      gl.bindBuffer(gl.ARRAY_BUFFER, mb.shade); gl.bufferData(gl.ARRAY_BUFFER,g.shade,gl.STATIC_DRAW); gl.enableVertexAttribArray(a.shade); gl.vertexAttribPointer(a.shade,1,gl.FLOAT,false,0,0);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, mb.idx); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER,g.idx,gl.STATIC_DRAW);
    }
  }
  SB.WebGLRenderer = WebGLRenderer;
})(typeof window !== "undefined" ? window : globalThis);
