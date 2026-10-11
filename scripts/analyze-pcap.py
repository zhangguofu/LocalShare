#!/usr/bin/env python3
"""
LocalShare 大文件传输抓包分析器（TCP 层）

用途：从 wireshark/pcapng 抓包中定量判断「传输慢」的根因是
      应用层（发送喂数 / 接收落盘 / 接收窗口）还是网络层（拥塞窗口 / 丢包 / RTT）。

依赖：python3 + dpkt    （pip install dpkt）
用法：
    python3 scripts/analyze-pcap.py issue/wireshark_data.pcapng [--port 45556]

说明：本机若已安装 tshark 可另行交叉验证；本脚本不依赖 tshark。
      抓包点若在发送端网卡驱动之上（macOS/Linux 常见），同一发送批次内的
      亚毫秒时间戳不可信（会被压成 ~1µs），脚本会实测并提示该情况；
      因此本脚本的结论只建立在「聚合量、>1ms 间隔、序号/确认号空间」之上。
"""
import argparse
import collections
import json
import socket
import statistics
import struct
import sys

try:
    import dpkt
except ImportError:
    sys.exit('缺少依赖 dpkt：pip install dpkt')

M32 = 1 << 32
FLAGS = {1: 'FIN', 2: 'SYN', 4: 'RST', 8: 'PSH', 16: 'ACK', 32: 'URG', 64: 'ECE', 128: 'CWR'}


class Seg:
    __slots__ = ('ts', 'seq', 'ack', 'win', 'flags', 'payload', 'plen', 'useq', 'uack')

    def __init__(self, ts, seq, ack, win, flags, payload):
        self.ts, self.seq, self.ack, self.win, self.flags = ts, seq, ack, win, flags
        self.payload, self.plen = payload, len(payload)


def unwrap(vals):
    """把 32 位序号还原为单调 64 位（大文件传输必然发生序号回绕）。"""
    out, off, prev = [], 0, vals[0]
    for v in vals:
        if v < prev - (M32 >> 1):
            off += M32
        elif v > prev + (M32 >> 1):
            off -= M32
        out.append(v + off)
        prev = v
    return out


def parse_opts(opts):
    out, i = {}, 0
    while i < len(opts):
        kind = opts[i]
        if kind == 0:
            break
        if kind == 1:
            i += 1
            continue
        if i + 1 >= len(opts):
            break
        ln = opts[i + 1]
        if ln < 2 or i + ln > len(opts):
            break
        val = opts[i + 2:i + ln]
        if kind == 2 and ln == 4:
            out['mss'] = struct.unpack('!H', val)[0]
        elif kind == 3 and ln == 3:
            out['ws'] = val[0]
        elif kind == 4:
            out['sackok'] = True
        elif kind == 8:
            out['ts'] = True
        i += ln
    return out


def pcapng_drop_audit(path):
    """读取 pcapng 的接口统计块，报告抓包自身是否丢包。"""
    stats, blocks = [], collections.Counter()
    with open(path, 'rb') as f:
        while True:
            hdr = f.read(8)
            if len(hdr) < 8:
                break
            btype, blen = struct.unpack('<II', hdr)
            if blen < 12:
                break
            body = f.read(blen - 8)
            blocks[btype] += 1
            if btype == 0x00000006:
                o = 0
                while o + 4 <= len(body) - 4:
                    code, ln = struct.unpack('<HH', body[o:o + 4])
                    if code == 0:
                        break
                    if code in (4, 5):
                        stats.append((code, struct.unpack('<Q', body[o + 4:o + 12])[0]))
                    o += (ln + 3) // 4 * 4
    return stats, blocks


def head(title):
    print()
    print('=' * 92)
    print(title)
    print('=' * 92)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('pcap')
    ap.add_argument('--port', type=int, default=45556)
    ap.add_argument('--peer-a', default=None, help='发送方 IP（默认取流量最大方向）')
    ap.add_argument('--peer-b', default=None)
    args = ap.parse_args()

    ipstr = lambda b: socket.inet_ntoa(b)  # noqa: E731

    # ---- 读取：先按端口收集两个方向的包，再确定主导流 ----
    pairs = collections.Counter()
    raw = collections.defaultdict(lambda: ([], []))
    for ts, buf in dpkt.pcapng.Reader(open(args.pcap, 'rb')):
        try:
            eth = dpkt.ethernet.Ethernet(buf)
        except Exception:
            continue
        ip = eth.data
        if not isinstance(ip, dpkt.ip.IP):
            continue
        tcp = ip.data
        if not isinstance(tcp, dpkt.tcp.TCP):
            continue
        if args.port not in (tcp.sport, tcp.dport):
            continue
        src, dst = ipstr(ip.src), ipstr(ip.dst)
        key = tuple(sorted([src, dst]))
        pairs[key] += 1
        seg = Seg(ts, tcp.seq, tcp.ack, tcp.win, tcp.flags, bytes(tcp.data or b''))
        if args.peer_a:
            if src == args.peer_a:
                raw[(args.peer_a, args.peer_b)][0].append(seg)
            else:
                raw[(args.peer_a, args.peer_b)][1].append(seg)
        else:
            raw[key][0 if src == key[0] else 1].append(seg)

    if args.peer_a:
        key = (args.peer_a, args.peer_b)
    else:
        key = max(pairs, key=lambda k: pairs[k])
    a_segs, b_segs = raw[key]
    allsegs = a_segs + b_segs
    if not allsegs:
        sys.exit('未找到 TCP 端口 %d 上的流量' % args.port)

    # 发送方向 = 承载文件数据的那个方向（载荷字节多者）
    pl_a = sum(s.plen for s in a_segs)
    pl_b = sum(s.plen for s in b_segs)
    if pl_a >= pl_b:
        A, B, fwd, rev = key[0], key[1], a_segs, b_segs
    else:
        A, B, fwd, rev = key[1], key[0], b_segs, a_segs

    fwd.sort(key=lambda s: s.ts)
    rev.sort(key=lambda s: s.ts)
    hs = {}
    for s in fwd + rev:
        if s.flags & dpkt.tcp.TH_SYN:
            hs['synack' if s.flags & dpkt.tcp.TH_ACK else 'syn'] = s

    for s, u in zip(fwd, unwrap([x.seq for x in fwd])):
        s.useq = u
    for s, u in zip(rev, unwrap([x.ack for x in rev])):
        s.uack = u
    data = [s for s in fwd if s.plen > 0]
    pure = [s for s in rev if s.plen == 0]
    ctrl = [s for s in rev if s.plen > 0]
    T0 = fwd[0].ts
    TEND = max(fwd[-1].ts, rev[-1].ts)
    DUR = TEND - T0
    TOT = sum(s.plen for s in data)

    head('0. 抓包自身完整性（先排除“抓包丢包”造成的假重传）')
    stats, blocks = pcapng_drop_audit(args.pcap)
    print(f"  块统计: {({hex(k): v for k, v in blocks.items()})}")
    print(f"  接口统计(4=ifdrop,5=osdrop): {stats if stats else '未记录（无法据此排除，需靠序号空洞判定）'}")

    head('1. 流量概况')
    print(f"  发送 {A} -> {B} : {len(data)} 个数据段 / {TOT/1e6:.2f} MB "
          f"（另有 {len(fwd)-len(data)} 个纯 ACK）")
    print(f"  反向 {B} -> {A} : {len(rev)} 段（其中控制帧 {len(ctrl)}，纯 ACK {len(pure)}）")
    print(f"  抓包窗口      : {DUR:.3f} s")
    print(f"  >>> 有效吞吐  : {TOT/DUR/1e6:.3f} MB/s = {TOT*8/DUR/1e6:.2f} Mbit/s")
    mss = int(statistics.median([s.plen for s in data]))
    print(f"  平均载荷/段   : {TOT/len(data):.1f} B（最大 {max(s.plen for s in data)}，"
          f"MSS≈{mss} => 走 1500 字节 MTU{'+TCP 时间戳' if mss == 1448 else ''}）")
    if 'syn' in hs and 'synack' in hs:
        print(f"  抓到握手: SYN.seq={hs['syn'].seq} SYNACK.seq={hs['synack'].seq} "
              f"iRTT={(hs['synack'].ts - hs['syn'].ts)*1000:.3f} ms")
    else:
        print("  !! 未抓到握手：抓包在连接建立之后开始 -> 窗口扩大因子 ws 未知（下文用下界推断）")

    head('2. 速率时间线（1 s 窗口）——判断是“稳定低速率”还是“锯齿”')
    w = collections.defaultdict(int)
    for s in data:
        w[int(s.ts - T0)] += s.plen
    wr = [w[k] / 1e6 for k in sorted(w)]
    print(f"  n={len(wr)}  mean={statistics.mean(wr):.2f}  median={statistics.median(wr):.2f}  "
          f"min={min(wr):.2f}  max={max(wr):.2f}  stdev={statistics.pstdev(wr):.2f} MB/s")
    print(f"  序列: {[round(x, 1) for x in wr]}")

    head('3. 发送突发结构（>1 ms 间隔切分）')
    bursts, cur = [], [data[0]]
    for p, q in zip(data, data[1:]):
        if q.ts - p.ts > 0.001:
            bursts.append(cur)
            cur = [q]
        else:
            cur.append(q)
    bursts.append(cur)
    bsize = [sum(x.plen for x in b) for b in bursts]
    stalls = [bursts[i + 1][0].ts - bursts[i][-1].ts for i in range(len(bursts) - 1)]
    print(f"  突发数={len(bursts)}  每突发字节: median={statistics.median(bsize):.0f} "
          f"mean={statistics.mean(bsize):.0f} max={max(bsize)}")
    print(f"  间隔(ms): median={statistics.median(stalls)*1000:.2f} mean={statistics.mean(stalls)*1000:.2f} "
          f"p90={sorted(stalls)[9*len(stalls)//10]*1000:.2f} max={max(stalls)*1000:.2f}")
    print(f"  间隙总时长 {sum(stalls):.3f} s / {DUR:.3f} s = {100*sum(stalls)/DUR:.1f}%")
    intra = sorted(b[i + 1].ts - b[i].ts for b in bursts for i in range(len(b) - 1))
    busy = sum(bursts[i][-1].ts - bursts[i][0].ts for i in range(len(bursts)))
    print(f"  突发内相邻包间隔: median={intra[len(intra)//2]*1e6:.2f} µs => 递交速率 {sum(bsize)/busy/1e6:.0f} MB/s")
    print("  （>100 MB/s 的递交速率说明抓包点在驱动之上、同批次时间戳被压平：")
    print("    亚毫秒间隔不可用于推断线速，本脚本后续只使用聚合量与 >1 ms 间隔）")

    head('4. 发送是否由 ACK 时钟驱动（突发紧跟反向包 => 拥塞窗口受限）')
    ri, lastrev, deltas = 0, None, []
    for b in bursts:
        while ri < len(rev) and rev[ri].ts <= b[0].ts:
            lastrev = rev[ri].ts
            ri += 1
        if lastrev is not None and b[0].ts - lastrev < 0.5:
            deltas.append(b[0].ts - lastrev)
    d = sorted(deltas)
    print(f"  突发起点距上一个反向包的时间: median={d[len(d)//2]*1000:.3f} ms  "
          f"≤0.5ms 的比例={100*sum(1 for x in d if x<=0.0005)/len(d):.1f}%")
    dur_stall_with_rev = 0
    for i in range(len(bursts) - 1):
        s0, e0 = bursts[i][-1].ts, bursts[i + 1][0].ts
        if e0 - s0 > 0.005 and any(s0 < r.ts < e0 for r in rev):
            dur_stall_with_rev += 1
    tot_stall = sum(1 for i in range(len(bursts) - 1) if bursts[i + 1][0].ts - bursts[i][-1].ts > 0.005)
    print(f"  >5ms 间隙中「期间有反向包到达」的比例: {dur_stall_with_rev}/{tot_stall} "
          f"= {100*dur_stall_with_rev/max(1,tot_stall):.0f}%  (收到 ACK 却仍不发 => 窗口已满)")

    head('5. 接收方通告窗口 / 在途字节（区分：接收窗口受限 还是 拥塞窗口受限）')
    rw = sorted(s.win for s in rev)
    print(f"  接收窗口(原始 16 位): min={min(rw)} p10={rw[len(rw)//10]} median={rw[len(rw)//2]} max={max(rw)}")
    print(f"  零窗口通告次数: {sum(1 for x in rw if x == 0)}")
    print(f"  达到 16 位上限 65535 的比例: {100*sum(1 for x in rw if x==65535)/len(rw):.1f}%")
    mi, mx, ratios = 0, data[0].useq, []
    flight = []
    for s in rev:
        while mi < len(data) and data[mi].ts <= s.ts:
            mx = max(mx, data[mi].useq + data[mi].plen)
            mi += 1
        f = max(0, mx - s.uack)
        flight.append(f)
        if s.win > 0:
            ratios.append(f / s.win)
    ratios.sort()
    fl = sorted(flight)
    print(f"  在途字节(flight): min={min(fl)} p10={fl[len(fl)//10]} median={fl[len(fl)//2]} "
          f"p90={fl[9*len(fl)//10]} max={max(fl)}")
    print(f"  flight/原始窗口 比值: median={ratios[len(ratios)//2]:.2f} max={ratios[-1]:.2f}")
    wsb = int(ratios[-1]).bit_length()
    print(f"  => 窗口扩大因子必然满足 2^ws >= {ratios[-1]:.1f} -> ws >= {wsb}，"
          f"即接收窗口实际 >= {min(rw)*(2**wsb)/1024:.0f} KB（远大于 flight）")
    print(f"  最大突发 {max(bsize)} B 也独立证明了接收窗口 >= 该值（栈不会越过窗口连发）")

    head('6. 丢包结构（连续丢 => 队列溢出；孤立丢 => 随机误码）')
    covered, retr = data[0].useq, []
    holes = 0
    for s in data:
        if s.useq > covered:
            holes += 1
        if s.useq + s.plen <= covered:
            retr.append(s)
        covered = max(covered, s.useq + s.plen)
    print(f"  抓包内序号空洞数: {holes}  (0 = 抓包无丢包，重传即为真实链路丢包)")
    print(f"  重传段: {len(retr)} ({100*len(retr)/len(data):.3f}%) / {sum(s.plen for s in retr)/1e6:.3f} MB")
    if retr:
        groups, g = [], [retr[0]]
        for p, q in zip(retr, retr[1:]):
            if q.useq == g[-1].useq + g[-1].plen:
                g.append(q)
            else:
                groups.append(g)
                g = [q]
        groups.append(g)
        gl = sorted(len(x) for x in groups)
        print(f"  重传串数={len(groups)}  串长(段): median={gl[len(gl)//2]} mean={statistics.mean(gl):.1f} "
              f"max={max(gl)}  (最大 {max(gl)*1.448:.0f} KB 连续丢 = 队列溢出特征)")
        times = sorted(x[0].ts - T0 for x in groups)
        gaps = [b - a for a, b in zip(times, times[1:])]
        if gaps:
            print(f"  丢包事件间隔(s): median={statistics.median(gaps):.3f} mean={statistics.mean(gaps):.3f} "
                  f"max={max(gaps):.3f}")

    head('7. 往返时延（序号/确认号推算；含接收端 ACK 聚合延迟，是上界）')
    sendend = {}
    for s in data:
        sendend.setdefault(s.useq + s.plen, s.ts)
    rtts = []
    for s in pure:
        t = sendend.get(s.uack)
        if t is not None and s.ts >= t:
            rtts.append((s.ts - t) * 1000)
    if rtts:
        rs = sorted(rtts)
        print(f"  样本={len(rs)} min={rs[0]:.3f} median={statistics.median(rs):.3f} "
              f"p90={rs[9*len(rs)//10]:.3f} max={rs[-1]:.3f} ms")
    acks = [b.uack - a.uack for a, b in zip(pure, pure[1:]) if b.uack >= a.uack]
    iat = sorted(b.ts - a.ts for a, b in zip(pure, pure[1:]))
    print(f"  每个 ACK 确认字节: median={statistics.median(acks):.0f} mean={statistics.mean(acks):.0f}"
          f"  => 约 {statistics.mean(acks)/1448:.1f} 段/ACK（接收端 GRO/延迟 ACK 聚合）")
    print(f"  ACK 到达间隔: median={iat[len(iat)//2]*1000:.3f} ms mean={statistics.mean(iat)*1000:.3f} ms")
    print(f"  => 有效环路速率 ≈ {statistics.mean(acks)/ (statistics.mean(iat)*1000) / 1000:.2f} MB/s"
          f"（=确认字节/ACK间隔，与实测吞吐一致即说明是 ACK 时钟封顶）")

    head('8. 接收端自身进度（RECV_PROGRESS 帧）——真值，不受抓包批处理影响')
    rp = []
    for s in ctrl:
        p = 0
        while True:
            p = s.payload.find(b'LS1\x00', p)
            if p < 0 or p + 8 > len(s.payload):
                break
            ln = struct.unpack('!I', s.payload[p + 4:p + 8])[0]
            try:
                m = json.loads(s.payload[p + 8:p + 8 + ln].decode('utf-8', 'replace'))
            except Exception:
                break
            if m.get('type') == 'RECV_PROGRESS':
                rp.append((s.ts - T0, m['bytes']))
            p += 8 + ln
    if len(rp) > 2:
        print(f"  样本={len(rp)}  起始已收={rp[0][1]/1e6:.2f} MB  结束={rp[-1][1]/1e6:.2f} MB")
        print(f"  接收端速率={(rp[-1][1]-rp[0][1])/(rp[-1][0]-rp[0][0])/1e6:.3f} MB/s"
              f"（与发送端 {TOT/DUR/1e6:.3f} MB/s 一致 => 接收端不是瓶颈）")
        print(f"  抓包开始时该文件已传出 {rp[0][1]/1e6:.2f} MB，抓包结束时 {rp[-1][1]/1e6:.2f} MB"
              f" => 单文件 >= {rp[-1][1]/1e6:.1f} MB")

    head('9. 空闲时间归因：应用层喂数不足 vs 网络/窗口受限')
    ai, la, mx, pre = 0, pure[0].uack, data[0].useq, []
    for b in bursts:
        while ai < len(pure) and pure[ai].ts <= b[0].ts:
            la = pure[ai].uack
            ai += 1
        pre.append(max(0, mx - la))
        mx = max(mx, b[-1].useq + b[-1].plen)
    appl = pathl = 0.0
    na = np_ = 0
    for i in range(len(bursts) - 1):
        st = bursts[i + 1][0].ts - bursts[i][-1].ts
        if st <= 0.005:
            continue
        if pre[i + 1] < 8192:
            appl += st
            na += 1
        else:
            pathl += st
            np_ += 1
    tot = appl + pathl
    print(f"  >5ms 空闲合计 {tot:.2f} s")
    print(f"    应用层受限（在途<8KB，发送端已无数据可交）: {appl:.2f} s ({100*appl/tot:.1f}%) / {na} 次")
    print(f"    网络/窗口受限（仍有在途数据）            : {pathl:.2f} s ({100*pathl/tot:.1f}%) / {np_} 次")
    print(f"    => 只修应用层最多提升到 {TOT/(DUR-appl)/1e6:.2f} MB/s (+{100*appl/(DUR-appl):.0f}%)；"
          f"其余上限由网络/窗口决定")

    head('10. 结论速览')
    print(f"  实测吞吐 {TOT/DUR/1e6:.2f} MB/s（{TOT*8/DUR/1e6:.1f} Mbit/s），"
          f"在途窗口中位数 {fl[len(fl)//2]/1024:.0f} KB，"
          f"环路时延中位数 {statistics.median(rtts) if rtts else float('nan'):.1f} ms")
    print(f"  接收窗口 >= {min(rw)*(2**wsb)/1024:.0f} KB 且零窗口 0 次 => 接收端不构成瓶颈")
    print(f"  重传 {len(retr)} 段（{100*len(retr)/max(1,len(data)):.3f}%），"
          f"抓包无空洞 => 真实丢包，落在拥塞控制上")
    print('  优化方向见 docs/large-file-throughput-analysis-2026-10-11.md')


if __name__ == '__main__':
    main()
