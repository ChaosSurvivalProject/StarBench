/* StarBench Web — WebGL 1.0 渲染器
 * 每帧从真实世界网格绘制；固定运镜脚本；天空、雾、方向光。
 */
(function (global) {
  "use strict";
  const SB = (global.SB = global.SB || {});

  // 极简 mat4（列主序）
  const M4 = {
    identity: () => new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]),
    perspective(fovy, aspect, near, far) {
      const f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far);
      return new Float32Array([
        f/aspect,0,0,0,
        0,f,0,0,
        0,0,(far+near)*nf,-1,
        0,0,2*far*near*nf,0,
      ]);
    },
    lookAt(eye, center, up) {
      let zx=eye[0]-center[0], zy=eye[1]-center[1], zz=eye[2]-center[2];
      let l=Math.hypot(zx,zy,zz)||1; zx/=l;zy/=l;zz/=l;
      let xx=up[1]*zz-up[2]*zy, xy=up[2]*zx-up[0]*zz, xz=up[0]*zy-up[1]*zx;
      l=Math.hypot(xx,xy,xz)||1; xx/=l;xy/=l;xz/=l;
      const yx=zy*xz-zz*xy, yy=zz*xx-zx*xz, yz=zx*xy-zy*xx;
      return new Float32Array([
        xx,yx,zx,0,
        xy,yy,zy,0,
        xz,yz,zz,0,
        -(xx*eye[0]+xy*eye[1]+xz*eye[2]),
        -(yx*eye[0]+yy*eye[1]+yz*eye[2]),
        -(zx*eye[0]+zy*eye[1]+zz*eye[2]), 1,
      ]);
    },
    mul(a, b) {
      const o = new Float32Array(16);
      for (let c=0;c<4;c++) for (let r=0;r<4;r++) {
        o[c*4+r]=a[r]*b[c*4]+a[4+r]*b[c*4+1]+a[8+r]*b[c*4+2]+a[12+r]*b[c*4+3];
      }
      return o;
    },
  };

  const VS = `
    attribute vec3 aPos;
    attribute vec2 aUV;
    attribute float aLight;
    uniform mat4 uMVP;
    uniform vec3 uEye;
    varying vec2 vUV;
    varying float vLight;
    varying float vDist;
    void main() {
      vUV = aUV; vLight = aLight;
      vDist = distance(aPos, uEye);
      gl_Position = uMVP * vec4(aPos, 1.0);
    }`;
  const FS = `
    precision mediump float;
    uniform sampler2D uTex;
    uniform vec3 uFog;
    uniform float uFogNear;
    uniform float uFogFar;
    varying vec2 vUV;
    varying float vLight;
    varying float vDist;
    void main() {
      vec4 tex = texture2D(uTex, vUV);
      vec3 col = tex.rgb * (0.25 + 0.75 * vLight);
      float f = clamp((vDist - uFogNear) / (uFogFar - uFogNear), 0.0, 1.0);
      gl_FragColor = vec4(mix(col, uFog, f), 1.0);
    }`;

  function compile(gl, type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  }

  class WebGLRenderer {
    constructor(glCanvas, screenCanvas) {
      this.canvas = glCanvas;              // 离屏 WebGL 画布（真实渲染负载）
      this.screen = screenCanvas;          // 可见 2D 画布（标准 DOM 合成，任何环境都能显示）
      this.screenCtx = screenCanvas ? screenCanvas.getContext('2d') : null;
      const gl = glCanvas.getContext('webgl', { antialias: true, alpha: false, preserveDrawingBuffer: true })
        || glCanvas.getContext('experimental-webgl');
      if (!gl) throw new Error('WebGL 不可用');
      this.gl = gl;
      this.prog = gl.createProgram();
      gl.attachShader(this.prog, compile(gl, gl.VERTEX_SHADER, VS));
      gl.attachShader(this.prog, compile(gl, gl.FRAGMENT_SHADER, FS));
      gl.linkProgram(this.prog);
      if (!gl.getProgramParameter(this.prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(this.prog));
      gl.useProgram(this.prog);
      this.a = {
        pos: gl.getAttribLocation(this.prog, 'aPos'),
        uv: gl.getAttribLocation(this.prog, 'aUV'),
        light: gl.getAttribLocation(this.prog, 'aLight'),
      };
      this.u = {
        mvp: gl.getUniformLocation(this.prog, 'uMVP'),
        eye: gl.getUniformLocation(this.prog, 'uEye'),
        tex: gl.getUniformLocation(this.prog, 'uTex'),
        fog: gl.getUniformLocation(this.prog, 'uFog'),
        fogNear: gl.getUniformLocation(this.prog, 'uFogNear'),
        fogFar: gl.getUniformLocation(this.prog, 'uFogFar'),
      };
      this.buf = { pos: gl.createBuffer(), uv: gl.createBuffer(), light: gl.createBuffer() };
      const atlas = SB.buildAtlas();
      this.tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.tex);
      // canvas 顶行对应图集第 0 行，翻转 Y 使其与 UV 的 v 计算一致（v=1 在顶部）
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, atlas);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.enable(gl.DEPTH_TEST);
      gl.enable(gl.CULL_FACE);
      gl.cullFace(gl.BACK);
      this.vertexCount = 0;
      this.camAngle = 0;
      this.resize();
    }

    resize() {
      const c = this.canvas;
      const dpr = Math.min(global.devicePixelRatio || 1, 2);
      // 尺寸以可见屏幕画布为准（离屏 gl 画布已被压到 1px）
      const ref = this.screen || c;
      const w = Math.max(1, Math.floor(ref.clientWidth * dpr));
      const h = Math.max(1, Math.floor(ref.clientHeight * dpr));
      if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
      this.gl.viewport(0, 0, c.width, c.height);
      if (this.screen && (this.screen.width !== c.width || this.screen.height !== c.height)) {
        this.screen.width = c.width;
        this.screen.height = c.height;
      }
    }

    upload(world) {
      const mesh = world.mesh;
      const gl = this.gl;
      const bind = (buf, arr, loc) => {
        gl.bindBuffer(gl.ARRAY_BUFFER, buf);
        gl.bufferData(gl.ARRAY_BUFFER, arr, gl.STATIC_DRAW);
        gl.enableVertexAttribArray(loc);
        gl.vertexAttribPointer(loc, arr === mesh.light ? 1 : (arr === mesh.uv ? 2 : 3), gl.FLOAT, false, 0, 0);
      };
      bind(this.buf.pos, mesh.position, this.a.pos);
      bind(this.buf.uv, mesh.uv, this.a.uv);
      bind(this.buf.light, mesh.light, this.a.light);
      this.vertexCount = mesh.vertexCount;
      this.worldCenter = [(world.sx - 1) / 2, world.h * 0.35, (world.sz - 1) / 2];
      this.radius = Math.max(world.sx, world.sz) * 0.72;
    }

    // 固定运镜脚本：绕场景公转 + 轻微俯仰摆动，确保每帧真实绘制
    draw(dtSec) {
      const gl = this.gl, c = this.canvas;
      this.resize();
      this.camAngle += dtSec * 0.9;
      const ctr = this.worldCenter || [0, 0, 0];
      const R = this.radius || 24;
      const eye = [
        ctr[0] + Math.cos(this.camAngle) * R,
        ctr[1] + 10 + Math.sin(this.camAngle * 0.7) * 4,
        ctr[2] + Math.sin(this.camAngle) * R,
      ];
      const proj = M4.perspective(50 * Math.PI / 180, c.width / c.height, 0.1, 400);
      const view = M4.lookAt(eye, ctr, [0, 1, 0]);
      gl.useProgram(this.prog);
      gl.uniformMatrix4fv(this.u.mvp, false, M4.mul(proj, view));
      gl.uniform3fv(this.u.eye, eye);
      gl.uniform3fv(this.u.fog, [0.62, 0.76, 0.90]);
      gl.uniform1f(this.u.fogNear, R * 0.9);
      gl.uniform1f(this.u.fogFar, R * 2.3);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.tex);
      gl.uniform1i(this.u.tex, 0);
      gl.clearColor(0.62, 0.76, 0.90, 1);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      if (this.vertexCount > 0) gl.drawArrays(gl.TRIANGLES, 0, this.vertexCount);
      // 把离屏 WebGL 画面拷到可见 2D 画布（标准合成层，确保任何环境都能显示）。
      // drawImage 会自动按 WebGL 的正确朝向绘制，无需手动翻转 Y。
      if (this.screenCtx) {
        this.screenCtx.drawImage(c, 0, 0);
      }
    }
  }
  SB.WebGLRenderer = WebGLRenderer;
})(typeof window !== "undefined" ? window : globalThis);
