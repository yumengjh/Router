#!/usr/bin/env node

/**
 * 纯原生Node.js开发服务器
 * 支持History模式路由、静态文件服务、热重载
 * 不依赖任何第三方库
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const { exec } = require('child_process');

// 服务器配置
const CONFIG = {
    port: process.env.PORT || 3000,
    host: process.env.HOST || 'localhost',
    root: process.cwd(),
    historyFallback: true,
    hotReload: true,
    cors: true,
    gzip: true,
    cache: false, // 开发模式禁用缓存
    openBrowser: true
};

// MIME类型映射
const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.htm': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.webp': 'image/webp',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.eot': 'application/vnd.ms-fontobject',
    '.txt': 'text/plain; charset=utf-8',
    '.xml': 'application/xml; charset=utf-8',
    '.pdf': 'application/pdf',
    '.zip': 'application/zip',
    '.tar': 'application/x-tar',
    '.gz': 'application/gzip'
};

// 日志颜色
const COLORS = {
    reset: '\x1b[0m',
    bright: '\x1b[1m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    magenta: '\x1b[35m',
    cyan: '\x1b[36m',
    white: '\x1b[37m'
};

// 日志函数
const log = {
    info: (msg) => console.log(`${COLORS.cyan}[INFO]${COLORS.reset} ${msg}`),
    success: (msg) => console.log(`${COLORS.green}[SUCCESS]${COLORS.reset} ${msg}`),
    warn: (msg) => console.log(`${COLORS.yellow}[WARN]${COLORS.reset} ${msg}`),
    error: (msg) => console.log(`${COLORS.red}[ERROR]${COLORS.reset} ${msg}`),
    request: (method, path, status) => {
        const statusColor = status >= 400 ? COLORS.red : status >= 300 ? COLORS.yellow : COLORS.green;
        console.log(`${COLORS.blue}[${method}]${COLORS.reset} ${path} ${statusColor}${status}${COLORS.reset}`);
    }
};

// 工具函数
const utils = {
    // 获取文件MIME类型
    getMimeType(filePath) {
        const ext = path.extname(filePath).toLowerCase();
        return MIME_TYPES[ext] || 'application/octet-stream';
    },

    // 检查文件是否存在
    fileExists(filePath) {
        try {
            return fs.statSync(filePath).isFile();
        } catch {
            return false;
        }
    },

    // 检查目录是否存在
    dirExists(dirPath) {
        try {
            return fs.statSync(dirPath).isDirectory();
        } catch {
            return false;
        }
    },

    // 读取文件内容
    async readFile(filePath) {
        return new Promise((resolve, reject) => {
            fs.readFile(filePath, (err, data) => {
                if (err) reject(err);
                else resolve(data);
            });
        });
    },

    // 获取文件统计信息
    async getFileStat(filePath) {
        return new Promise((resolve, reject) => {
            fs.stat(filePath, (err, stats) => {
                if (err) reject(err);
                else resolve(stats);
            });
        });
    },

    // 解析URL参数
    parseQuery(queryString) {
        const params = new URLSearchParams(queryString);
        const result = {};
        for (const [key, value] of params) {
            result[key] = value;
        }
        return result;
    },

    // 生成ETag
    generateETag(content) {
        const crypto = require('crypto');
        return `"${crypto.createHash('md5').update(content).digest('hex')}"`;
    },

    // 格式化文件大小
    formatFileSize(bytes) {
        if (bytes === 0) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    },

    // 获取客户端IP
    getClientIP(req) {
        return req.headers['x-forwarded-for'] || 
               req.headers['x-real-ip'] || 
               req.connection.remoteAddress || 
               req.socket.remoteAddress ||
               (req.connection.socket ? req.connection.socket.remoteAddress : null) ||
               '127.0.0.1';
    }
};

// 热重载功能
class HotReloader {
    constructor() {
        this.clients = new Set();
        this.watchers = new Map();
    }

    // 添加WebSocket客户端
    addClient(ws) {
        this.clients.add(ws);
        
        // 设置关闭事件处理器
        if (ws.onclose) {
            const originalOnClose = ws.onclose;
            ws.onclose = () => {
                this.clients.delete(ws);
                if (originalOnClose) originalOnClose();
            };
        } else {
            ws.onclose = () => {
                this.clients.delete(ws);
            };
        }
    }

    // 开始监听文件变化
    watch(directory) {
        if (this.watchers.has(directory)) return;

        try {
            const watcher = fs.watch(directory, { recursive: true }, (eventType, filename) => {
                if (filename && (filename.endsWith('.html') || filename.endsWith('.css') || filename.endsWith('.js'))) {
                    log.info(`文件变化: ${filename}`);
                    this.notifyClients('reload', { file: filename, type: eventType });
                }
            });

            this.watchers.set(directory, watcher);
            log.info(`开始监听文件变化: ${directory}`);
        } catch (error) {
            log.warn(`无法监听目录: ${directory}`);
        }
    }

    // 通知客户端重新加载
    notifyClients(type, data) {
        const message = JSON.stringify({ type, data, timestamp: Date.now() });
        this.clients.forEach(client => {
            try {
                if (client.readyState === 1) { // WebSocket.OPEN
                    client.send(message);
                }
            } catch (error) {
                this.clients.delete(client);
            }
        });
    }

    // 生成热重载客户端脚本
    getClientScript() {
        return `
            <script>
            (function() {
                let ws;
                let reconnectAttempts = 0;
                const maxReconnectAttempts = 5;
                
                function connect() {
                    try {
                        ws = new WebSocket('ws://localhost:${CONFIG.port}/__hot_reload__');
                        
                        ws.onopen = function() {
                            console.log('%c[HMR] 🔥 热重载已连接', 'color: #4ade80; font-weight: bold;');
                            reconnectAttempts = 0;
                        };
                        
                        ws.onmessage = function(event) {
                            try {
                                const message = JSON.parse(event.data);
                                if (message.type === 'reload') {
                                    console.log('%c[HMR] 🔄 检测到文件变化，正在重新加载...', 'color: #fbbf24; font-weight: bold;');
                                    setTimeout(() => {
                                        window.location.reload();
                                    }, 100);
                                }
                            } catch (e) {
                                console.warn('[HMR] 解析消息失败:', e);
                            }
                        };
                        
                        ws.onerror = function(error) {
                            console.warn('[HMR] WebSocket错误:', error);
                        };
                        
                        ws.onclose = function() {
                            console.log('%c[HMR] 🔌 连接已断开', 'color: #f87171;');
                            
                            if (reconnectAttempts < maxReconnectAttempts) {
                                setTimeout(() => {
                                    reconnectAttempts++;
                                    console.log('[HMR] 尝试重新连接... (' + reconnectAttempts + '/' + maxReconnectAttempts + ')');
                                    connect();
                                }, 1000 * reconnectAttempts);
                            } else {
                                console.log('%c[HMR] ❌ 达到最大重连次数，停止尝试', 'color: #ef4444;');
                            }
                        };
                    } catch (error) {
                        console.warn('[HMR] 无法建立WebSocket连接:', error);
                        if (reconnectAttempts < maxReconnectAttempts) {
                            setTimeout(() => {
                                reconnectAttempts++;
                                connect();
                            }, 2000);
                        }
                    }
                }
                
                if (document.readyState === 'loading') {
                    document.addEventListener('DOMContentLoaded', connect);
                } else {
                    connect();
                }
                
                // 页面卸载时关闭连接
                window.addEventListener('beforeunload', function() {
                    if (ws && ws.readyState === WebSocket.OPEN) {
                        ws.close();
                    }
                });
            })();
            </script>
        `;
    }

    // 停止监听
    stop() {
        this.watchers.forEach(watcher => watcher.close());
        this.watchers.clear();
        this.clients.clear();
    }
}

// 静态文件服务器
class StaticFileServer {
    constructor() {
        this.hotReloader = CONFIG.hotReload ? new HotReloader() : null;
    }

    // 处理静态文件请求
    async handleStaticFile(req, res, filePath) {
        try {
            // 检查文件是否存在
            if (!utils.fileExists(filePath)) {
                return this.send404(res);
            }

            const stats = await utils.getFileStat(filePath);
            const mimeType = utils.getMimeType(filePath);
            
            // 设置响应头
            const headers = {
                'Content-Type': mimeType,
                'Content-Length': stats.size,
                'Last-Modified': stats.mtime.toUTCString(),
                'Accept-Ranges': 'bytes'
            };

            // 开发模式禁用缓存
            if (!CONFIG.cache) {
                headers['Cache-Control'] = 'no-cache, no-store, must-revalidate';
                headers['Pragma'] = 'no-cache';
                headers['Expires'] = '0';
            }

            // 处理条件请求
            const ifModifiedSince = req.headers['if-modified-since'];
            if (ifModifiedSince && new Date(ifModifiedSince) >= stats.mtime) {
                res.writeHead(304, headers);
                res.end();
                return;
            }

            // 处理Range请求（断点续传）
            const range = req.headers.range;
            if (range) {
                return this.handleRangeRequest(req, res, filePath, stats, headers);
            }

            // 读取并发送文件
            const content = await utils.readFile(filePath);
            
            // 如果是HTML文件且启用了热重载，注入热重载脚本
            if (this.hotReloader && mimeType.includes('text/html')) {
                const htmlContent = content.toString();
                const scriptTag = this.hotReloader.getClientScript();
                const modifiedContent = htmlContent.replace('</body>', `${scriptTag}</body>`);
                headers['Content-Length'] = Buffer.byteLength(modifiedContent);
                res.writeHead(200, headers);
                res.end(modifiedContent);
            } else {
                res.writeHead(200, headers);
                res.end(content);
            }

        } catch (error) {
            log.error(`读取文件失败: ${error.message}`);
            this.send500(res, error.message);
        }
    }

    // 处理Range请求
    async handleRangeRequest(req, res, filePath, stats, headers) {
        const range = req.headers.range;
        const parts = range.replace(/bytes=/, '').split('-');
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : stats.size - 1;
        const chunkSize = (end - start) + 1;

        headers['Content-Range'] = `bytes ${start}-${end}/${stats.size}`;
        headers['Content-Length'] = chunkSize;

        res.writeHead(206, headers);

        const stream = fs.createReadStream(filePath, { start, end });
        stream.pipe(res);
    }

    // 处理目录列表
    async handleDirectory(req, res, dirPath) {
        try {
            const files = fs.readdirSync(dirPath);
            const fileList = [];

            for (const file of files) {
                const filePath = path.join(dirPath, file);
                const stats = fs.statSync(filePath);
                fileList.push({
                    name: file,
                    size: stats.size,
                    isDirectory: stats.isDirectory(),
                    mtime: stats.mtime
                });
            }

            // 排序：目录在前，文件在后
            fileList.sort((a, b) => {
                if (a.isDirectory && !b.isDirectory) return -1;
                if (!a.isDirectory && b.isDirectory) return 1;
                return a.name.localeCompare(b.name);
            });

            const html = this.generateDirectoryListingHTML(req.url, fileList);
            
            res.writeHead(200, {
                'Content-Type': 'text/html; charset=utf-8',
                'Cache-Control': 'no-cache'
            });
            res.end(html);

        } catch (error) {
            log.error(`读取目录失败: ${error.message}`);
            this.send500(res, error.message);
        }
    }

    // 生成目录列表HTML
    generateDirectoryListingHTML(currentPath, files) {
        const parentPath = currentPath !== '/' ? path.dirname(currentPath) : null;
        
        let html = `
        <!DOCTYPE html>
        <html lang="zh-CN">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>目录列表 - ${currentPath}</title>
            <style>
                * { margin: 0; padding: 0; box-sizing: border-box; }
                body { 
                    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; 
                    background: #f8fafc; color: #334155; line-height: 1.6; 
                }
                .container { max-width: 1200px; margin: 0 auto; padding: 20px; }
                .header { 
                    background: white; padding: 30px; border-radius: 12px; 
                    box-shadow: 0 1px 3px rgba(0,0,0,0.1); margin-bottom: 20px; 
                }
                .header h1 { color: #1e293b; margin-bottom: 10px; }
                .breadcrumb { color: #64748b; font-size: 14px; }
                .file-list { background: white; border-radius: 12px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
                .file-item { 
                    display: flex; align-items: center; padding: 12px 20px; 
                    border-bottom: 1px solid #e2e8f0; text-decoration: none; color: inherit;
                    transition: background-color 0.2s;
                }
                .file-item:hover { background: #f1f5f9; }
                .file-item:last-child { border-bottom: none; }
                .file-icon { width: 24px; margin-right: 12px; text-align: center; }
                .file-name { flex: 1; font-weight: 500; }
                .file-size { color: #64748b; font-size: 14px; min-width: 80px; text-align: right; margin-right: 20px; }
                .file-date { color: #64748b; font-size: 14px; min-width: 150px; text-align: right; }
                .directory { color: #3b82f6; }
                .footer { text-align: center; margin-top: 30px; color: #64748b; font-size: 14px; }
            </style>
        </head>
        <body>
            <div class="container">
                <div class="header">
                    <h1>📁 目录列表</h1>
                    <div class="breadcrumb">当前路径: ${currentPath}</div>
                </div>
                
                <div class="file-list">
        `;

        // 添加返回上级目录链接
        if (parentPath !== null) {
            html += `
                <a href="${parentPath}" class="file-item">
                    <div class="file-icon">⬆️</div>
                    <div class="file-name directory">.. (返回上级目录)</div>
                    <div class="file-size"></div>
                    <div class="file-date"></div>
                </a>
            `;
        }

        // 添加文件和目录
        files.forEach(file => {
            const icon = file.isDirectory ? '📁' : this.getFileIcon(file.name);
            const size = file.isDirectory ? '' : utils.formatFileSize(file.size);
            const date = file.mtime.toLocaleDateString() + ' ' + file.mtime.toLocaleTimeString();
            const className = file.isDirectory ? 'directory' : '';
            const href = path.join(currentPath, file.name).replace(/\\/g, '/');

            html += `
                <a href="${href}" class="file-item">
                    <div class="file-icon">${icon}</div>
                    <div class="file-name ${className}">${file.name}</div>
                    <div class="file-size">${size}</div>
                    <div class="file-date">${date}</div>
                </a>
            `;
        });

        html += `
                </div>
                
                <div class="footer">
                    <p>🚀 开发服务器 - 端口 ${CONFIG.port}</p>
                </div>
            </div>
            
            ${this.hotReloader ? this.hotReloader.getClientScript() : ''}
        </body>
        </html>
        `;

        return html;
    }

    // 获取文件图标
    getFileIcon(filename) {
        const ext = path.extname(filename).toLowerCase();
        const iconMap = {
            '.html': '🌐', '.htm': '🌐',
            '.js': '📜', '.mjs': '📜', '.ts': '📜',
            '.css': '🎨', '.scss': '🎨', '.sass': '🎨',
            '.json': '📋', '.xml': '📋', '.yaml': '📋', '.yml': '📋',
            '.md': '📝', '.txt': '📝',
            '.png': '🖼️', '.jpg': '🖼️', '.jpeg': '🖼️', '.gif': '🖼️', '.svg': '🖼️',
            '.mp4': '🎬', '.avi': '🎬', '.mov': '🎬', '.webm': '🎬',
            '.mp3': '🎵', '.wav': '🎵', '.flac': '🎵',
            '.zip': '📦', '.tar': '📦', '.gz': '📦', '.rar': '📦',
            '.pdf': '📄', '.doc': '📄', '.docx': '📄'
        };
        return iconMap[ext] || '📄';
    }

    // 发送404错误
    send404(res) {
        const html = `
        <!DOCTYPE html>
        <html lang="zh-CN">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>404 - 页面未找到</title>
            <style>
                body { 
                    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                    display: flex; justify-content: center; align-items: center; 
                    min-height: 100vh; margin: 0; 
                    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                    color: white; text-align: center; 
                }
                .error-container { padding: 40px; }
                .error-code { font-size: 8rem; font-weight: 900; margin-bottom: 20px; opacity: 0.8; }
                .error-message { font-size: 1.5rem; margin-bottom: 30px; }
                .back-button { 
                    display: inline-block; padding: 12px 24px; 
                    background: rgba(255,255,255,0.2); color: white; 
                    text-decoration: none; border-radius: 8px; 
                    transition: background 0.3s; 
                }
                .back-button:hover { background: rgba(255,255,255,0.3); }
            </style>
        </head>
        <body>
            <div class="error-container">
                <div class="error-code">404</div>
                <div class="error-message">🔍 页面未找到</div>
                <a href="/" class="back-button">返回首页</a>
            </div>
        </body>
        </html>
        `;
        
        res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
    }

    // 发送500错误
    send500(res, message) {
        const html = `
        <!DOCTYPE html>
        <html lang="zh-CN">
        <head>
            <meta charset="UTF-8">
            <title>500 - 服务器错误</title>
            <style>
                body { 
                    font-family: system-ui; display: flex; justify-content: center; 
                    align-items: center; min-height: 100vh; margin: 0; 
                    background: #f87171; color: white; text-align: center; 
                }
                .error-container { padding: 40px; }
                .error-code { font-size: 6rem; margin-bottom: 20px; }
                .error-message { font-size: 1.2rem; }
            </style>
        </head>
        <body>
            <div class="error-container">
                <div class="error-code">500</div>
                <div class="error-message">⚠️ 服务器内部错误<br><small>${message}</small></div>
            </div>
        </body>
        </html>
        `;
        
        res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
    }
}

// 主服务器类
class DevServer {
    constructor() {
        this.server = null;
        this.staticFileServer = new StaticFileServer();
    }

    // 启动服务器
    start() {
        this.server = http.createServer((req, res) => {
            this.handleRequest(req, res);
        });

        // 处理WebSocket升级（热重载）
        if (CONFIG.hotReload) {
            this.server.on('upgrade', (request, socket, head) => {
                this.handleWebSocketUpgrade(request, socket, head);
            });
        }

        this.server.listen(CONFIG.port, CONFIG.host, () => {
            this.onServerStart();
        });

        // 错误处理
        this.server.on('error', (error) => {
            if (error.code === 'EADDRINUSE') {
                log.error(`端口 ${CONFIG.port} 已被占用`);
                process.exit(1);
            } else {
                log.error(`服务器错误: ${error.message}`);
            }
        });

        // 优雅关闭
        process.on('SIGINT', () => {
            log.info('正在关闭服务器...');
            this.stop();
        });

        process.on('SIGTERM', () => {
            log.info('正在关闭服务器...');
            this.stop();
        });
    }

    // 服务器启动后的处理
    onServerStart() {
        const url = `http://${CONFIG.host}:${CONFIG.port}`;
        
        log.success(`🚀 开发服务器已启动！`);
        log.info(`📍 本地地址: ${COLORS.cyan}${url}${COLORS.reset}`);
        log.info(`📁 根目录: ${COLORS.cyan}${CONFIG.root}${COLORS.reset}`);
        log.info(`⚡ History模式: ${COLORS.green}已启用${COLORS.reset}`);
        
        if (CONFIG.hotReload) {
            log.info(`🔥 热重载: ${COLORS.green}已启用${COLORS.reset}`);
            this.staticFileServer.hotReloader.watch(CONFIG.root);
        }
        
        if (CONFIG.cors) {
            log.info(`🌐 CORS: ${COLORS.green}已启用${COLORS.reset}`);
        }

        // 自动打开浏览器
        if (CONFIG.openBrowser) {
            this.openBrowser(url);
        }
    }

    // 处理HTTP请求
    async handleRequest(req, res) {
        const startTime = Date.now();
        const clientIP = utils.getClientIP(req);
        
        try {
            // 设置CORS头
            if (CONFIG.cors) {
                res.setHeader('Access-Control-Allow-Origin', '*');
                res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
                res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
            }

            // 处理OPTIONS请求
            if (req.method === 'OPTIONS') {
                res.writeHead(200);
                res.end();
                return;
            }

            const parsedUrl = url.parse(req.url, true);
            const pathname = decodeURIComponent(parsedUrl.pathname);
            
            // 安全检查：防止目录遍历攻击
            if (pathname.includes('..') || pathname.includes('\0')) {
                res.writeHead(400, { 'Content-Type': 'text/plain' });
                res.end('Bad Request');
                return;
            }

            const filePath = path.join(CONFIG.root, pathname);

            // 处理根路径
            if (pathname === '/') {
                await this.handleRootPath(req, res, filePath);
            } 
            // 检查是否为静态文件
            else if (utils.fileExists(filePath)) {
                await this.staticFileServer.handleStaticFile(req, res, filePath);
            }
            // 检查是否为目录
            else if (utils.dirExists(filePath)) {
                await this.handleDirectory(req, res, filePath);
            }
            // History模式回退
            else if (CONFIG.historyFallback) {
                await this.handleHistoryFallback(req, res);
            }
            // 文件不存在
            else {
                this.staticFileServer.send404(res);
            }

            const duration = Date.now() - startTime;
            log.request(req.method, pathname, res.statusCode, `${duration}ms`, clientIP);

        } catch (error) {
            log.error(`请求处理失败: ${error.message}`);
            this.staticFileServer.send500(res, error.message);
        }
    }

    // 处理根路径
    async handleRootPath(req, res, rootPath) {
        // 寻找默认文件
        const indexFiles = ['index.html', 'index.htm', 'default.html'];
        
        for (const indexFile of indexFiles) {
            const indexPath = path.join(rootPath, indexFile);
            if (utils.fileExists(indexPath)) {
                await this.staticFileServer.handleStaticFile(req, res, indexPath);
                return;
            }
        }

        // 没有找到默认文件，显示目录列表
        await this.staticFileServer.handleDirectory(req, res, rootPath);
    }

    // 处理目录请求
    async handleDirectory(req, res, dirPath) {
        // 检查是否有默认文件
        const indexFiles = ['index.html', 'index.htm', 'default.html'];
        
        for (const indexFile of indexFiles) {
            const indexPath = path.join(dirPath, indexFile);
            if (utils.fileExists(indexPath)) {
                await this.staticFileServer.handleStaticFile(req, res, indexPath);
                return;
            }
        }

        // 显示目录列表
        await this.staticFileServer.handleDirectory(req, res, dirPath);
    }

    // 处理History模式回退
    async handleHistoryFallback(req, res) {
        // 寻找根目录下的index.html
        const indexPath = path.join(CONFIG.root, 'index.html');
        
        if (utils.fileExists(indexPath)) {
            await this.staticFileServer.handleStaticFile(req, res, indexPath);
        } else {
            // 如果没有index.html，返回404
            log.warn('History模式回退失败：找不到 index.html');
            this.staticFileServer.send404(res);
        }
    }

    // 处理WebSocket升级（热重载）
    handleWebSocketUpgrade(request, socket, head) {
        const pathname = url.parse(request.url).pathname;
        
        if (pathname === '/__hot_reload__') {
            try {
                // 简单的WebSocket握手
                const key = request.headers['sec-websocket-key'];
                if (!key) {
                    socket.end();
                    return;
                }
                
                const acceptKey = this.generateWebSocketAcceptKey(key);
                
                const responseHeaders = [
                    'HTTP/1.1 101 Switching Protocols',
                    'Upgrade: websocket',
                    'Connection: Upgrade',
                    `Sec-WebSocket-Accept: ${acceptKey}`,
                    '', ''
                ].join('\r\n');
                
                socket.write(responseHeaders);
                
                // 创建简单的WebSocket包装器
                const ws = this.createWebSocketWrapper(socket);
                
                if (this.staticFileServer.hotReloader) {
                    this.staticFileServer.hotReloader.addClient(ws);
                    log.info('热重载客户端已连接');
                } else {
                    log.warn('热重载功能未启用');
                    socket.end();
                }
            } catch (error) {
                log.error('WebSocket握手失败:', error.message);
                socket.end();
            }
        } else {
            socket.end();
        }
    }

    // 生成WebSocket Accept Key
    generateWebSocketAcceptKey(key) {
        const crypto = require('crypto');
        const magic = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
        return crypto.createHash('sha1').update(key + magic).digest('base64');
    }

    // 创建WebSocket包装器
    createWebSocketWrapper(socket) {
        const ws = {
            readyState: 1, // WebSocket.OPEN
            send: (data) => {
                if (socket.writable) {
                    try {
                        const frame = this.createWebSocketFrame(data);
                        socket.write(frame);
                    } catch (error) {
                        console.warn('WebSocket发送失败:', error.message);
                    }
                }
            },
            close: () => {
                try {
                    socket.end();
                } catch (error) {
                    console.warn('WebSocket关闭失败:', error.message);
                }
            },
            onclose: null,
            onerror: null,
            onmessage: null
        };

        // 处理socket事件
        socket.on('close', () => {
            ws.readyState = 3; // WebSocket.CLOSED
            if (ws.onclose) ws.onclose();
        });

        socket.on('error', (error) => {
            log.warn('WebSocket socket错误:', error.message);
            if (ws.onerror) ws.onerror(error);
        });

        // 处理WebSocket帧
        socket.on('data', (buffer) => {
            try {
                const message = this.parseWebSocketFrame(buffer);
                if (message && ws.onmessage) {
                    ws.onmessage({ data: message });
                }
            } catch (error) {
                log.warn('WebSocket消息解析失败:', error.message);
            }
        });

        return ws;
    }

    // 创建WebSocket帧
    createWebSocketFrame(data) {
        const payload = Buffer.from(data, 'utf8');
        const payloadLength = payload.length;
        
        let frame;
        if (payloadLength < 126) {
            frame = Buffer.allocUnsafe(2 + payloadLength);
            frame[0] = 0x81; // FIN + text frame
            frame[1] = payloadLength;
            payload.copy(frame, 2);
        } else if (payloadLength < 65536) {
            frame = Buffer.allocUnsafe(4 + payloadLength);
            frame[0] = 0x81;
            frame[1] = 126;
            frame.writeUInt16BE(payloadLength, 2);
            payload.copy(frame, 4);
        } else {
            frame = Buffer.allocUnsafe(10 + payloadLength);
            frame[0] = 0x81;
            frame[1] = 127;
            frame.writeUInt32BE(0, 2);
            frame.writeUInt32BE(payloadLength, 6);
            payload.copy(frame, 10);
        }
        
        return frame;
    }

    // 解析WebSocket帧
    parseWebSocketFrame(buffer) {
        if (buffer.length < 2) return null;
        
        const firstByte = buffer[0];
        const secondByte = buffer[1];
        
        const fin = !!(firstByte & 0x80);
        const opcode = firstByte & 0x0f;
        const masked = !!(secondByte & 0x80);
        let payloadLength = secondByte & 0x7f;
        
        let offset = 2;
        
        if (payloadLength === 126) {
            if (buffer.length < offset + 2) return null;
            payloadLength = buffer.readUInt16BE(offset);
            offset += 2;
        } else if (payloadLength === 127) {
            if (buffer.length < offset + 8) return null;
            payloadLength = buffer.readUInt32BE(offset + 4); // 忽略高32位
            offset += 8;
        }
        
        if (masked) {
            if (buffer.length < offset + 4) return null;
            const maskKey = buffer.slice(offset, offset + 4);
            offset += 4;
            
            if (buffer.length < offset + payloadLength) return null;
            const payload = Buffer.allocUnsafe(payloadLength);
            
            for (let i = 0; i < payloadLength; i++) {
                payload[i] = buffer[offset + i] ^ maskKey[i % 4];
            }
            
            return payload.toString('utf8');
        } else {
            if (buffer.length < offset + payloadLength) return null;
            return buffer.slice(offset, offset + payloadLength).toString('utf8');
        }
    }

    // 打开浏览器
    openBrowser(url) {
        const start = process.platform === 'darwin' ? 'open' :
                     process.platform === 'win32' ? 'start' : 'xdg-open';
        
        exec(`${start} ${url}`, (error) => {
            if (error) {
                log.warn(`无法自动打开浏览器: ${error.message}`);
                log.info(`请手动打开浏览器访问: ${url}`);
            } else {
                log.info('🌐 浏览器已自动打开');
            }
        });
    }

    // 停止服务器
    stop() {
        if (this.server) {
            this.server.close(() => {
                log.success('✅ 服务器已关闭');
                process.exit(0);
            });

            // 停止热重载
            if (this.staticFileServer.hotReloader) {
                this.staticFileServer.hotReloader.stop();
            }

            // 强制关闭
            setTimeout(() => {
                log.warn('⏰ 强制关闭服务器');
                process.exit(1);
            }, 5000);
        }
    }

    // 获取服务器状态
    getStatus() {
        return {
            port: CONFIG.port,
            host: CONFIG.host,
            root: CONFIG.root,
            historyMode: CONFIG.historyFallback,
            hotReload: CONFIG.hotReload,
            cors: CONFIG.cors,
            uptime: process.uptime()
        };
    }
}

// 命令行参数解析
function parseArgs() {
    const args = process.argv.slice(2);
    
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        
        switch (arg) {
            case '-p':
            case '--port':
                CONFIG.port = parseInt(args[++i]) || 3000;
                break;
            case '-h':
            case '--host':
                CONFIG.host = args[++i] || 'localhost';
                break;
            case '-r':
            case '--root':
                CONFIG.root = path.resolve(args[++i] || process.cwd());
                break;
            case '--no-hot-reload':
                CONFIG.hotReload = false;
                break;
            case '--no-cors':
                CONFIG.cors = false;
                break;
            case '--no-open':
                CONFIG.openBrowser = false;
                break;
            case '--no-history':
                CONFIG.historyFallback = false;
                break;
            case '--help':
                showHelp();
                process.exit(0);
                break;
            case '--version':
                console.log('Dev Server v1.0.0');
                process.exit(0);
                break;
            default:
                if (arg.startsWith('-')) {
                    log.warn(`未知参数: ${arg}`);
                }
                break;
        }
    }
}

// 显示帮助信息
function showHelp() {
    console.log(`
${COLORS.bright}📡 开发服务器 - 纯原生Node.js实现${COLORS.reset}

${COLORS.cyan}用法:${COLORS.reset}
  node server.js [选项]

${COLORS.cyan}选项:${COLORS.reset}
  -p, --port <port>      端口号 (默认: 3000)
  -h, --host <host>      主机地址 (默认: localhost)  
  -r, --root <path>      根目录 (默认: 当前目录)
  --no-hot-reload        禁用热重载
  --no-cors              禁用CORS
  --no-open              禁用自动打开浏览器
  --no-history           禁用History模式回退
  --help                 显示帮助信息
  --version              显示版本信息

${COLORS.cyan}特性:${COLORS.reset}
  ✅ History模式路由支持
  ✅ 热重载 (WebSocket)
  ✅ CORS支持
  ✅ 静态文件服务
  ✅ 目录浏览
  ✅ 断点续传
  ✅ 缓存控制
  ✅ 安全防护

${COLORS.cyan}示例:${COLORS.reset}
  node server.js                    # 使用默认配置启动
  node server.js -p 8080           # 在8080端口启动
  node server.js -r ./dist         # 指定./dist为根目录
  node server.js --no-hot-reload   # 禁用热重载功能

${COLORS.green}💡 提示: 确保项目中有 router.js 文件才能正常使用路由功能${COLORS.reset}
`);
}

// 检查环境
function checkEnvironment() {
    // 检查Node.js版本
    const nodeVersion = process.version;
    const majorVersion = parseInt(nodeVersion.slice(1).split('.')[0]);
    
    if (majorVersion < 12) {
        log.error(`Node.js版本过低: ${nodeVersion}, 需要 v12.0.0 或更高版本`);
        process.exit(1);
    }

    // 检查根目录是否存在
    if (!utils.dirExists(CONFIG.root)) {
        log.error(`根目录不存在: ${CONFIG.root}`);
        process.exit(1);
    }

    // 检查端口范围
    if (CONFIG.port < 1 || CONFIG.port > 65535) {
        log.error(`端口号无效: ${CONFIG.port}`);
        process.exit(1);
    }
}

// 显示启动横幅
function showBanner() {
    console.log(`
${COLORS.cyan}╔══════════════════════════════════════════════════════════════╗
║                     🚀 开发服务器启动中...                      ║
║                  纯原生 Node.js 实现 • 零依赖                   ║
╚══════════════════════════════════════════════════════════════╝${COLORS.reset}
`);
}

// 主函数
function main() {
    try {
        showBanner();
        parseArgs();
        checkEnvironment();
        
        const server = new DevServer();
        server.start();
        
    } catch (error) {
        log.error(`启动失败: ${error.message}`);
        process.exit(1);
    }
}

// 处理未捕获的异常
process.on('uncaughtException', (error) => {
    log.error(`未捕获的异常: ${error.message}`);
    console.error(error.stack);
    process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    log.error(`未处理的Promise拒绝: ${reason}`);
    console.error('Promise:', promise);
});

// 如果直接运行此文件，则启动服务器
if (require.main === module) {
    main();
}

// 导出服务器类供其他模块使用
module.exports = { DevServer, CONFIG, utils };