/**
 * 站点/区域查找脚本
 * 用法: node scripts/lookup_station.js <query>
 * 输出: JSON { type: "area"|"station"|"none", areas?: [...], stations?: [...] }
 */
const fs = require('fs');
const path = require('path');

const query = process.argv[2] || '';

const areaData = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'near-areas.json'), 'utf-8'));
const detailData = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'tide-stations.json'), 'utf-8'));

const areas = areaData.Data;       // [{ID, AreaName}]
const stations = detailData.Data;  // [{Code, Name, AreaID}]

// 构建 AreaID → AreaName 映射
const areaNameMap = {};
areas.forEach(a => { areaNameMap[a.ID] = a.AreaName; });

// 空查询：列出全部区域
if (query === '') {
    console.log(JSON.stringify({
        type: 'area',
        areas: areas,
        stations: [],
        stationCount: 0,
        hint: '请选择区域后再查站点'
    }, null, 2));
    process.exit(0);
}

// 1. 尝试按区域名匹配
const areaMatches = areas.filter(a => a.AreaName.includes(query));

if (areaMatches.length > 0) {
    // 找到了区域，列出该区域下的站点
    const areaIdSet = new Set(areaMatches.map(a => a.ID));
    const matchedStations = stations
        .filter(s => areaIdSet.has(s.AreaID))
        .map(s => ({ Code: s.Code, Name: s.Name, AreaID: s.AreaID, AreaName: areaNameMap[s.AreaID] || '' }));

    console.log(JSON.stringify({
        type: 'area',
        areas: areaMatches,
        stations: matchedStations,
        stationCount: matchedStations.length
    }, null, 2));
} else {
    // 2. 尝试按站点名模糊匹配
    const stationMatches = stations
        .filter(s => s.Name.includes(query) || s.Code.toUpperCase().includes(query.toUpperCase()))
        .map(s => ({ Code: s.Code, Name: s.Name, AreaID: s.AreaID, AreaName: areaNameMap[s.AreaID] || '' }));

    if (stationMatches.length > 0) {
        console.log(JSON.stringify({
            type: 'station',
            stations: stationMatches,
            stationCount: stationMatches.length
        }, null, 2));
    } else {
        // 3. 没匹配到，列出所有区域供选择
        console.log(JSON.stringify({
            type: 'none',
            hint: `未找到匹配「${query}」的区域或站点`,
            allAreas: areas
        }, null, 2));
    }
}
