// 快照插值：把服务端送来的实体位置缓冲渲染成"延迟 110ms 的平滑位置"。
// 联机时的探针鸡/网站鸡都走这里，保证两边的动作看起来一样、且不抖。

export const REMOTE_DELAY = 110;          // 渲染在 110ms 之前（够抵消一个快照往返的抖动）

/**
 * @param {Array<{t,x,y,z,yaw,hp,st}>} buf 快照缓冲（按时间升序）
 * @param {number} now performance.now()
 * @returns {{x:number,y:number,z:number,yaw:number,hp:number,st:number,speed:number}|null}
 */
export function sample(buf, now = performance.now()) {
  if (!buf || !buf.length) return null;
  const target = now - REMOTE_DELAY;
  let a = null, b = null;
  for (let i = buf.length - 1; i >= 0; i--) {
    if (buf[i].t <= target) { a = buf[i]; b = buf[i + 1] || null; break; }
  }
  if (!a) { a = buf[0]; b = buf[1] || null; }

  let { x, y, z, yaw, st, hp, scale } = a;
  let speed = 0;
  if (b) {
    const span = Math.max(1, b.t - a.t);
    const k = Math.min(1, Math.max(0, (target - a.t) / span));
    speed = Math.hypot(b.x - a.x, b.z - a.z) / (span / 1000);
    x += (b.x - x) * k; y += (b.y - y) * k; z += (b.z - z) * k;
    const dyaw = ((b.yaw - a.yaw + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
    yaw = a.yaw + dyaw * k;
    if (b.st & 1) st = b.st;              // 倒地位要立刻生效（别插值）
    hp = b.hp;
    if (b.scale != null) scale = b.scale; // 体型也别插值，直接取最新
  }
  return { x, y, z, yaw, hp, st, speed, scale };
}

/** 往缓冲里塞一帧（各处统一裁剪长度，避免无限增长） */
export function push(buf, x, z, y, yaw, hp, st, scale = 1, max = 12) {
  buf.push({ t: performance.now(), x, z, y, yaw, hp, st, scale });
  while (buf.length > max) buf.shift();
  return buf;
}
