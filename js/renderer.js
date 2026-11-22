/* StarBench Web — WebGL 1.0 渲染器
 * 每帧从真实世界网格绘制；固定运镜脚本；天空、雾、方向光。
 * 地形与动物两套程序：地形用 Faithful 64x 方块图集，动物用 22i 生物图集，
 * 每只动物带独立 model 矩阵（位置/朝向/步态），逐帧真实绘制。
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
    // 动物 model 矩阵：绕 Y 旋转 yaw + 平移 (x,y,z) + 轻微波步摆动
    model(x, y, z, yaw, bob, s) {
      s = s || 1;
      const cy=Math.cos(yaw)*s, sy=Math.sin(yaw)*s;
      return new Float32Array([
        cy,0,-sy,0,
        0,s,0,0,
        sy,0,cy,0,
        x,y+bob,z,1,
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
      if (tex.a<0.5) discard; // alpha 测试（叶片/动物透明区）
      vec3 col=tex.rgb*(0.25+0.75*vLight);
      float f=clamp((vDist-uFogNear)/(uFogFar-uFogNear),0.0,1.0);
      gl_FragColor=vec4(mix(col,uFog,f),1.0);
    }`;

  // 动物专用：带 model 矩阵 + 顶点级步态/光照
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
  // attrs/unis: [[shaderName, alias], ...]，位置存到 alias 键下
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

  class WebGLRenderer {
    constructor(glCanvas, screenCanvas) {
      this.canvas = glCanvas;
      this.screen = screenCanvas;
      this.screenCtx = screenCanvas ? screenCanvas.getContext('2d') : null;
      const gl = glCanvas.getContext('webgl', { antialias: true, alpha: false, preserveDrawingBuffer: true })
        || glCanvas.getContext('experimental-webgl');
      if (!gl) throw new Error('WebGL 不可用');
      this.gl = gl;

      this.terrain = program(gl, VS, FS,
        [['aPos','pos'],['aUV','uv'],['aLight','light']],
        [['uMVP','mvp'],['uEye','eye'],['uTex','tex'],['uFog','fog'],['uFogNear','fogNear'],['uFogFar','fogFar']]);
      this.mob = program(gl, MVS, MFS,
        [['aPos','pos'],['aUV','uv'],['aShade','shade']],
        [['uMVP','mvp'],['uModel','model'],['uEye','eye'],['uTex','tex'],['uFog','fog'],['uFogNear','fogNear'],['uFogFar','fogFar']]);

      this.buf = { pos: gl.createBuffer(), uv: gl.createBuffer(), light: gl.createBuffer() };
      const atlas = SB.buildAtlas();
      this.tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.tex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, atlas);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      this.atlasCanvas = atlas;
      const self = this;
      SB.onAtlasReady = function () { self.refreshTexture(); };

      // 动物纹理与几何
      this.mobTex = gl.createTexture();
      const mobAtlas = SB.buildMobAtlas();
      gl.bindTexture(gl.TEXTURE_2D, this.mobTex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, mobAtlas);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      this.mobAtlasCanvas = mobAtlas;
      SB.onMobAtlasReady = function () { self.refreshMobTexture(); };
      this.mobGeo = this._buildMobGeometry();
      this.mobBuf = { pos: gl.createBuffer(), uv: gl.createBuffer(), shade: gl.createBuffer(), idx: gl.createBuffer() };

      gl.enable(gl.DEPTH_TEST);
      gl.enable(gl.CULL_FACE);
      gl.cullFace(gl.BACK);
      this.vertexCount = 0;
      this.camAngle = 0;
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
            // 面明暗：用近似法向高度做稳定着色（顶部亮、底部暗）
            const ny = part.pos[i+1] / 5;
            shade.push(0.62 + 0.38 * Math.max(0, Math.min(1, 0.5 + ny)));
          }
          for (let i=0;i<part.uv.length;i+=2) {
            uv.push((col+part.uv[i])/C, 1-(row+part.uv[i+1])/R);
          }
          for (const ix of part.idx) idx.push(ix+base);
          base += part.pos.length/3;
        }
        out[name] = { pos:new Float32Array(pos), uv:new Float32Array(uv),
          shade:new Float32Array(shade), idx:new Uint16Array(idx) };
      }
      return out;
    }

    resize() {
      const c = this.canvas;
      const dpr = Math.min(global.devicePixelRatio || 1, 2);
      const ref = this.screen || c;
      const w = Math.max(1, Math.floor(ref.clientWidth * dpr));
      const h = Math.max(1, Math.floor(ref.clientHeight * dpr));
      if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
      this.gl.viewport(0, 0, c.width, c.height);
      if (this.screen && (this.screen.width !== c.width || this.screen.height !== c.height)) {
        this.screen.width = c.width; this.screen.height = c.height;
      }
    }

    upload(world) {
      const mesh = world.mesh;
      const gl = this.gl;
      const bind = (buf, arr, loc, size) => {
        gl.bindBuffer(gl.ARRAY_BUFFER, buf);
        gl.bufferData(gl.ARRAY_BUFFER, arr, gl.STATIC_DRAW);
        gl.enableVertexAttribArray(loc);
        gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
      };
      bind(this.buf.pos, mesh.position, this.terrain.a.pos, 3);
      bind(this.buf.uv, mesh.uv, this.terrain.a.uv, 2);
      bind(this.buf.light, mesh.light, this.terrain.a.light, 1);
      this.vertexCount = mesh.vertexCount;
      this.worldCenter = [(world.sx - 1) / 2, world.h * 0.35, (world.sz - 1) / 2];
      this.radius = Math.max(world.sx, world.sz) * 0.72;
      // 估算地表平均高度，供相机贴地
      let sum = 0, c = 0;
      for (let i = 0; i < world.surface.length; i += 37) { sum += world.surface[i]; c++; }
      this.groundY = c ? sum / c : world.h * 0.3;
      this.entityRef = world.entities;
    }

    _uploadMobGeo(g) {
      const gl=this.gl, mb=this.mobBuf, a=this.mob.a;
      gl.bindBuffer(gl.ARRAY_BUFFER, mb.pos); gl.bufferData(gl.ARRAY_BUFFER,g.pos,gl.STATIC_DRAW); gl.enableVertexAttribArray(a.pos); gl.vertexAttribPointer(a.pos,3,gl.FLOAT,false,0,0);
      gl.bindBuffer(gl.ARRAY_BUFFER, mb.uv); gl.bufferData(gl.ARRAY_BUFFER,g.uv,gl.STATIC_DRAW); gl.enableVertexAttribArray(a.uv); gl.vertexAttribPointer(a.uv,2,gl.FLOAT,false,0,0);
      gl.bindBuffer(gl.ARRAY_BUFFER, mb.shade); gl.bufferData(gl.ARRAY_BUFFER,g.shade,gl.STATIC_DRAW); gl.enableVertexAttribArray(a.shade); gl.vertexAttribPointer(a.shade,1,gl.FLOAT,false,0,0);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, mb.idx); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER,g.idx,gl.STATIC_DRAW);
    }

    draw(dtSec) {
      const gl = this.gl, c = this.canvas;
      if (this._texWarmup === undefined) this._texWarmup = 0;
      if (this._texWarmup < 180) {
        this.refreshTexture(); this.refreshMobTexture(); this._texWarmup++;
      }
      this.resize();
      this.camAngle += dtSec * 0.9;
      const ctr = this.worldCenter || [0, 0, 0];
      const R = this.radius || 24;
      // 相机贴近地表、距中心约半径的 0.62，让动物体素模型清晰可见
      const camR = R * 0.62;
      const groundY = this.groundY || (ctr[1] * 0.7);
      const eye = [
        ctr[0] + Math.cos(this.camAngle) * camR,
        groundY + 6 + Math.sin(this.camAngle * 0.7) * 2.5,
        ctr[2] + Math.sin(this.camAngle) * camR,
      ];
      const lookAt = [ctr[0], groundY + 1.5, ctr[2]];
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

      // ---- 动物 ----
      if (this.entityRef && this.entityRef.length) {
        gl.useProgram(this.mob.p);
        const M=this.mob;
        gl.uniformMatrix4fv(M.u.mvp,false,mvp); gl.uniform3fv(M.u.eye,eye);
        gl.uniform3fv(M.u.fog,fog); gl.uniform1f(M.u.fogNear,fogNear); gl.uniform1f(M.u.fogFar,fogFar);
        gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D,this.mobTex); gl.uniform1i(M.u.tex,0);
        let curType=null;
        for (const e of this.entityRef) {
          const g=this.mobGeo[e.type]; if (!g) continue;
          if (curType!==e.type) { this._uploadMobGeo(g); curType=e.type; }
          const bob=Math.abs(Math.sin(e.legPhase||0))*0.06;
          const ds = 2.0; // 显示放大，体素动物更清晰（压力不变）
          gl.uniformMatrix4fv(M.u.model,false,M4.model(e.x,e.y,e.z,e.yaw||0,bob,ds));
          gl.drawElements(gl.TRIANGLES,g.idx.length,gl.UNSIGNED_SHORT,0);
        }
      }

      if (this.screenCtx) this.screenCtx.drawImage(c, 0, 0);
    }
  }
  SB.WebGLRenderer = WebGLRenderer;
})(typeof window !== "undefined" ? window : globalThis);
