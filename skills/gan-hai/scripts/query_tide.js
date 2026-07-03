/**
 * 潮汐查询脚本
 * 用法: node scripts/query_tide.js <code> <date>
 * 参数: code=站点代码(如NT1005), date=日期(YYYY-MM-DD, 默认今天)
 * 输出: JSON 格式的完整潮汐表
 */
const https = require('https');
const url = require('url');

const code = process.argv[2];
const date = process.argv[3] || new Date().toISOString().slice(0, 10);

if (!code) {
    console.log(JSON.stringify({ error: '请提供站点代码，如: node scripts/query_tide.js NT1005 2026-07-05' }));
    process.exit(1);
}

// 验证日期格式
if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    console.log(JSON.stringify({ error: '日期格式错误，请使用 YYYY-MM-DD 格式' }));
    process.exit(1);
}

const apiUrl = 'https://global-tide.nmdis.org.cn/Api/Service.ashx';
const postData = `ApiRequest=${encodeURIComponent(JSON.stringify({
    Server: 'User',
    Command: 'GetData',
    Data: { code: code, date: date }
}))}`;

const parsedUrl = new url.URL(apiUrl);
const options = {
    hostname: parsedUrl.hostname,
    port: parsedUrl.port || 443,
    path: parsedUrl.pathname,
    method: 'POST',
    headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData)
    },
    timeout: 15000,
    rejectUnauthorized: false
};

const req = https.request(options, (res) => {
    let body = '';
    res.on('data', chunk => body += chunk);
    res.on('end', () => {
        try {
            const raw = JSON.parse(body);
            if (!raw.State || !raw.Data) {
                console.log(JSON.stringify({ error: 'API 返回异常', raw: raw }, null, 2));
                process.exit(1);
            }
            const result = formatTideData(raw.Data, date);
            console.log(JSON.stringify(result, null, 2));
        } catch (e) {
            console.log(JSON.stringify({ error: '解析响应失败: ' + e.message, body: body.substring(0, 500) }, null, 2));
            process.exit(1);
        }
    });
});

req.on('error', (e) => {
    console.log(JSON.stringify({ error: '网络请求失败: ' + e.message }, null, 2));
    process.exit(1);
});

req.on('timeout', () => {
    req.destroy();
    console.log(JSON.stringify({ error: '请求超时' }, null, 2));
    process.exit(1);
});

req.write(postData);
req.end();

/**
 * 格式化潮汐数据
 */
function formatTideData(data, queryDate) {
    const site = data.Site || {};
    const meta = data.Data || {};
    const sub = data.SubData || {};

    // 提取潮汐事件 (cs=时刻, cg=潮高)
    const events = [];
    for (let i = 0; i < 6; i++) {
        if (sub['cs' + i] && sub['cg' + i] != null) {
            events.push({ time: sub['cs' + i], height: sub['cg' + i] });
        }
    }

    // 判断高低潮: 高于平均值为高潮，低于为低潮
    if (events.length > 0) {
        const avgHeight = events.reduce((sum, e) => sum + e.height, 0) / events.length;
        events.forEach(e => {
            e.type = e.height >= avgHeight ? '高潮' : '低潮';
        });
        // 按时刻排序
        events.sort((a, b) => a.time.localeCompare(b.time));
    }

    // 24小时潮高曲线
    const hourlyHeights = [];
    for (let i = 0; i < 24; i++) {
        hourlyHeights.push(sub['a' + i] != null ? sub['a' + i] : null);
    }

    // 找出最佳赶海时段 (低潮前后1小时)
    const ganhaiWindows = events
        .filter(e => e.type === '低潮')
        .map(e => {
            const [h, m] = e.time.split(':').map(Number);
            const totalMin = h * 60 + m;
            const startMin = Math.max(0, totalMin - 60);
            const endMin = Math.min(23 * 60 + 59, totalMin + 60);
            const pad = (n) => String(n).padStart(2, '0');
            return {
                lowTide: e.time,
                height: e.height,
                window: `${pad(Math.floor(startMin / 60))}:${pad(startMin % 60)} ~ ${pad(Math.floor(endMin / 60))}:${pad(endMin % 60)}`
            };
        });

    return {
        queryDate: queryDate,
        station: {
            code: site.Code || code,
            name: site.Name || meta.Title || '',
            coordinate: meta.Coordinate || `(${site.CoordY}°, ${site.CoordX}°)`,
            timezone: meta.TimeArea || '',
            benchmark: meta.Benchmark || ''
        },
        tideEvents: events,
        ganhaiWindows: ganhaiWindows,
        hourlyHeights: hourlyHeights,
        hourlyTable: hourlyHeights.map((h, i) => ({
            hour: String(i).padStart(2, '0') + ':00',
            height: h
        })),
        trends: generateTrends(hourlyHeights, events, ganhaiWindows),
        summary: generateSummary(events, ganhaiWindows),
        rawSubData: sub
    };
}

/**
 * 生成潮汐趋势描述
 * 将一天划分为多个涨落潮阶段，用自然语言描述每个阶段的走势
 */
function generateTrends(hourlyHeights, events, ganhaiWindows) {
    if (events.length === 0) return [];

    // 构建完整的时间轴节点: 00:00 → 事件点 → 24:00
    const nodes = [];
    const h0 = hourlyHeights[0];
    if (h0 != null) {
        nodes.push({ time: '00:00', height: h0, type: null });
    }
    events.forEach(e => nodes.push({ time: e.time, height: e.height, type: e.type }));
    const h23 = hourlyHeights[23];
    if (h23 != null) {
        nodes.push({ time: '24:00', height: h23, type: null });
    }

    // 构建 赶海窗口 查找表 (按低潮时刻索引)
    const windowMap = {};
    ganhaiWindows.forEach(w => { windowMap[w.lowTide] = w.window; });

    const trends = [];
    const periodNames = ['凌晨', '早晨', '上午', '中午', '下午', '傍晚', '夜晚', '深夜'];

    for (let i = 0; i < nodes.length - 1; i++) {
        const a = nodes[i];
        const b = nodes[i + 1];
        const diff = b.height - a.height;
        const direction = diff > 0 ? '涨潮' : '退潮';
        const range = Math.abs(diff);

        // 计算时长(分钟)
        const [ah, am] = a.time.split(':').map(Number);
        const [bh, bm] = b.time.split(':').map(Number);
        let durationMin = (bh * 60 + bm) - (ah * 60 + am);
        if (durationMin <= 0) durationMin += 24 * 60;

        // 跳过不足 30 分钟且两端无事件点的尾部
        if (durationMin < 30 && !a.type && !b.type) continue;
        // 跳过尾部无变化段（最后一段、无事件、潮高不变或极短）
        if (i === nodes.length - 2 && !b.type && (range < 5 || durationMin < 60)) continue;

        const durationH = (durationMin / 60).toFixed(1);
        const rate = durationMin > 0 ? (range / (durationMin / 60)).toFixed(0) : '0';

        // 时段名称
        const midH = (ah + (durationMin / 60) / 2) % 24;
        const periodIdx = Math.floor(midH / 3) % 8;
        const periodName = periodNames[periodIdx];

        // 该阶段内的关键事件点（b 是事件点时标注）
        const keyEvent = b.type ? b : null;

        // 赶海窗口：仅在以低潮为终点的退潮段标注（退到最低点后适合赶海）
        let ganhaiWindow = null;
        if (b.type === '低潮' && direction === '退潮' && windowMap[b.time]) {
            ganhaiWindow = windowMap[b.time];
        }

        // 涨幅/降幅描述
        const rangeDesc = range >= 300 ? '大幅' : range >= 150 ? '明显' : '平缓';

        const trend = {
            period: periodName + direction,
            timeRange: a.time + ' → ' + b.time,
            direction: direction,
            startHeight: a.height,
            endHeight: b.height,
            range: range,
            rangeDesc: rangeDesc,
            duration: durationH + '小时',
            rate: '约' + rate + 'cm/小时',
            keyPoint: keyEvent ? {
                time: keyEvent.time,
                height: keyEvent.height,
                type: keyEvent.type
            } : null,
            ganhaiWindow: ganhaiWindow
        };
        trends.push(trend);
    }

    return trends;
}

/**
 * 生成赶海摘要
 */
function generateSummary(events, ganhaiWindows) {
    const lowTides = events.filter(e => e.type === '低潮');
    const highTides = events.filter(e => e.type === '高潮');

    // 找最低潮 (最适合赶海)
    const best = lowTides.length > 0
        ? lowTides.reduce((a, b) => a.height < b.height ? a : b)
        : null;

    const bestWindow = best && ganhaiWindows.find(w => w.lowTide === best.time);

    const parts = [];
    parts.push(`本日共有 ${lowTides.length} 次低潮、${highTides.length} 次高潮`);

    if (best) {
        parts.push(`最低潮出现在 ${best.time}（${best.height}cm），是最佳赶海时机`);
        if (bestWindow) {
            parts.push(`建议赶海窗口：${bestWindow.window}`);
        }
    }

    // 潮差最大的涨落
    let maxRange = 0, maxDesc = '';
    for (let i = 1; i < events.length; i++) {
        const r = Math.abs(events[i].height - events[i - 1].height);
        if (r > maxRange) { maxRange = r; maxDesc = events[i - 1].time + '→' + events[i].time; }
    }
    if (maxRange > 0) {
        parts.push(`最大潮差 ${maxRange}cm（${maxDesc}），潮水变化剧烈，注意安全`);
    }

    return parts.join('；') + '。';
}
