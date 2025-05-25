/**
 * 高级JavaScript路由器模块 - 完整修复版
 * 修复了内存泄漏、栈溢出、循环引用等问题
 * @version 2.2.0
 * @author Router Team
 */

// 路由模式枚举
const RouterMode = {
    HASH: 'hash',
    HISTORY: 'history',
    ABSTRACT: 'abstract'
};

// 导航类型枚举
const NavigationType = {
    PUSH: 'push',
    REPLACE: 'replace',
    POP: 'pop'
};

// 导航失败原因
const NavigationFailureType = {
    ABORTED: 'aborted',
    CANCELLED: 'cancelled', 
    DUPLICATED: 'duplicated',
    REDIRECTED: 'redirected'
};

// 配置项
const DEBUG = true;
const log = (...args) => DEBUG && console.log('[Router]', ...args);

// 导航失败错误类
class NavigationDuplicated extends Error {
    constructor(location) {
        super(`Navigating to current location ("${location.path}") is not allowed`);
        this.name = 'NavigationDuplicated';
        this.type = NavigationFailureType.DUPLICATED;
    }
}

class NavigationAborted extends Error {
    constructor(from, to) {
        super(`Navigation aborted from "${from.path}" to "${to.path}" via a navigation guard.`);
        this.name = 'NavigationAborted';
        this.type = NavigationFailureType.ABORTED;
    }
}

class NavigationCancelled extends Error {
    constructor(from, to) {
        super(`Navigation cancelled from "${from.path}" to "${to.path}" with a new navigation.`);
        this.name = 'NavigationCancelled';
        this.type = NavigationFailureType.CANCELLED;
    }
}

// 事件系统 - 修复内存泄漏
class EventEmitter {
    constructor() {
        this.events = new Map();
        this._maxListeners = 50;
        this._destroyed = false;
    }

    on(event, callback) {
        if (this._destroyed) return () => {};
        
        if (!this.events.has(event)) {
            this.events.set(event, new Set());
        }
        const listeners = this.events.get(event);
        if (listeners.size >= this._maxListeners) {
            console.warn(`[EventEmitter] Too many listeners for event: ${event}`);
            return () => {};
        }
        listeners.add(callback);
        return () => this.off(event, callback);
    }

    once(event, callback) {
        if (this._destroyed) return () => {};
        
        const wrapper = (...args) => {
            this.off(event, wrapper);
            callback(...args);
        };
        return this.on(event, wrapper);
    }

    off(event, callback) {
        if (this._destroyed) return;
        
        if (this.events.has(event)) {
            this.events.get(event).delete(callback);
            if (this.events.get(event).size === 0) {
                this.events.delete(event);
            }
        }
    }

    emit(event, ...args) {
        if (this._destroyed) return;
        
        if (this.events.has(event)) {
            const listeners = Array.from(this.events.get(event));
            listeners.forEach(callback => {
                try {
                    if (typeof callback === 'function') {
                        callback(...args);
                    }
                } catch (error) {
                    console.error(`[EventEmitter] Error in ${event} handler:`, error);
                }
            });
        }
    }

    clear() {
        this.events.clear();
    }

    destroy() {
        this._destroyed = true;
        this.clear();
    }
}

// 缓存管理 - LRU算法，添加内存监控
class RouteCache {
    constructor(maxSize = 50) {
        this.cache = new Map();
        this.maxSize = Math.min(maxSize, 200);
        this.accessTimes = new Map();
        this._destroyed = false;
    }

    get(key) {
        if (this._destroyed || !this.cache.has(key)) {
            return null;
        }
        
        const value = this.cache.get(key);
        this.cache.delete(key);
        this.cache.set(key, value);
        this.accessTimes.set(key, Date.now());
        return value;
    }

    set(key, value) {
        if (this._destroyed) return;
        
        if (this._getObjectSize(value) > 1024 * 1024) {
            console.warn('[RouteCache] Value too large, skipping cache');
            return;
        }
        
        if (this.cache.has(key)) {
            this.cache.delete(key);
            this.accessTimes.delete(key);
        } else if (this.cache.size >= this.maxSize) {
            const firstKey = this.cache.keys().next().value;
            this.cache.delete(firstKey);
            this.accessTimes.delete(firstKey);
        }
        
        this.cache.set(key, value);
        this.accessTimes.set(key, Date.now());
    }

    has(key) {
        return !this._destroyed && this.cache.has(key);
    }

    delete(key) {
        if (this._destroyed) return false;
        
        const result = this.cache.delete(key);
        this.accessTimes.delete(key);
        return result;
    }

    clear() {
        this.cache.clear();
        this.accessTimes.clear();
    }

    get size() {
        return this._destroyed ? 0 : this.cache.size;
    }

    _getObjectSize(obj) {
        try {
            return JSON.stringify(obj).length * 2;
        } catch {
            return 0;
        }
    }

    cleanup(maxAge = 30 * 60 * 1000) {
        if (this._destroyed) return;
        
        const now = Date.now();
        const keysToDelete = [];
        
        for (const [key, time] of this.accessTimes) {
            if (now - time > maxAge) {
                keysToDelete.push(key);
            }
        }
        
        keysToDelete.forEach(key => this.delete(key));
    }

    destroy() {
        this._destroyed = true;
        this.clear();
    }
}

// 路由记录类 - 修复循环引用问题
class RouteRecord {
    constructor(route, parent = null) {
        this.path = route.path;
        this.name = route.name;
        this.component = route.component;
        this.components = route.components;
        this.redirect = route.redirect;
        this.alias = route.alias;
        this.meta = route.meta || {};
        this.beforeEnter = route.beforeEnter;
        this.props = route.props;
        this.caseSensitive = route.caseSensitive !== false;
        this.pathToRegexpOptions = route.pathToRegexpOptions || {};
        
        this.parent = parent;
        this.children = [];
        this.instances = {};
        
        this.keys = [];
        this.regex = this.compileRouteRegex(route.path);
        
        this._fullPath = null;
        this._parentRef = parent ? new WeakRef(parent) : null;
    }

    compileRouteRegex(path) {
        if (!path || typeof path !== 'string') {
            return /^.*$/;
        }
        
        const keys = [];
        let regexPath = path
            .replace(/\/:([^/]+)\?/g, (match, key) => {
                keys.push({ name: key, optional: true });
                return '(?:/([^/]+))?';
            })
            .replace(/\/:([^/]+)/g, (match, key) => {
                keys.push({ name: key, optional: false });
                return '/([^/]+)';
            })
            .replace(/\/\*/, '/(.*)')
            .replace(/\/$/, '/?');
        
        this.keys = keys;
        
        if (path === '*') {
            return /^.*$/;
        }
        
        try {
            return new RegExp(`^${regexPath}$`, this.caseSensitive ? '' : 'i');
        } catch (e) {
            console.warn('[RouteRecord] Invalid regex pattern:', path);
            return /^.*$/;
        }
    }

    getFullPath() {
        if (this._fullPath) {
            return this._fullPath;
        }
        
        const pathSegments = [];
        let current = this;
        const visited = new WeakSet();
        let depth = 0;
        const maxDepth = 50;
        
        while (current && depth < maxDepth) {
            if (visited.has(current)) {
                console.warn('[RouteRecord] Circular reference detected in route hierarchy');
                break;
            }
            
            visited.add(current);
            pathSegments.unshift(current.path);
            
            if (current._parentRef) {
                current = current._parentRef.deref();
            } else {
                current = current.parent;
            }
            
            depth++;
        }
        
        this._fullPath = pathSegments.join('').replace(/\/+/g, '/') || '/';
        return this._fullPath;
    }

    addChild(child) {
        if (child && !this.children.includes(child)) {
            if (this.children.length < 100) {
                this.children.push(child);
            } else {
                console.warn('[RouteRecord] Too many child routes, ignoring new child');
            }
        }
    }

    destroy() {
        this.parent = null;
        this._parentRef = null;
        this.children = [];
        this.instances = {};
        this.component = null;
        this.components = null;
    }
}

// 路由匹配器 - 优化性能和内存使用
class RouteMatcher {
    constructor(routes = []) {
        this.pathList = [];
        this.pathMap = new Map();
        this.nameMap = new Map();
        this._routeRecords = new Set();
        this._destroyed = false;
        
        if (routes.length > 0) {
            this.createRouteMap(routes);
        }
    }

    createRouteMap(routes, oldPathList, oldPathMap, oldNameMap, parentRoute) {
        if (this._destroyed) return;
        
        routes.forEach(route => {
            this.addRouteRecord(route, parentRoute);
        });
    }

    addRouteRecord(route, parent) {
        if (this._destroyed || !route || !route.path) return;
        
        if (this.pathMap.has(route.path)) {
            console.warn(`[RouteMatcher] Route path "${route.path}" already exists`);
            return;
        }
        
        const record = new RouteRecord(route, parent);
        this._routeRecords.add(record);
        
        if (parent && !record.path.startsWith('/')) {
            const parentPath = parent.path.replace(/\/$/, '');
            record.path = parentPath + '/' + record.path;
        }

        this.pathList.push(record.path);
        this.pathMap.set(record.path, record);
        
        if (record.name && !this.nameMap.has(record.name)) {
            this.nameMap.set(record.name, record);
        }

        if (record.alias) {
            const aliases = Array.isArray(record.alias) ? record.alias.slice(0, 5) : [record.alias];
            aliases.forEach(alias => {
                if (alias && typeof alias === 'string' && !this.pathMap.has(alias)) {
                    const aliasRecord = { ...route, path: alias };
                    this.addRouteRecord(aliasRecord, parent);
                }
            });
        }

        if (route.children && Array.isArray(route.children) && this._getRouteDepth(record) < 10) {
            route.children.forEach(child => {
                this.addRouteRecord(child, record);
            });
        }

        if (parent) {
            parent.addChild(record);
        }
    }

    _getRouteDepth(record) {
        let depth = 0;
        let current = record.parent;
        const visited = new WeakSet();
        
        while (current && depth < 20) {
            if (visited.has(current)) break;
            visited.add(current);
            current = current.parent;
            depth++;
        }
        return depth;
    }

    match(raw, currentRoute) {
        if (this._destroyed) {
            return this.createRoute(null, { path: '/' });
        }
        
        const location = this.normalizeLocation(raw, currentRoute);
        if (!location) return this.createRoute(null, { path: '/' });
        
        const { path } = location;

        if (location.name) {
            const record = this.nameMap.get(location.name);
            if (record) {
                return this.createRoute(record, location);
            }
        }

        if (this.pathMap.has(path)) {
            const record = this.pathMap.get(path);
            return this.createRoute(record, location);
        }

        for (const record of this.pathMap.values()) {
            if (record.regex.test(path)) {
                const match = path.match(record.regex);
                if (match) {
                    return this.createRoute(record, location, match);
                }
            }
        }

        return this.createRoute(null, location);
    }

    createRoute(record, location, match = []) {
        const params = {};
        
        if (record && match.length > 1) {
            record.keys.forEach((key, index) => {
                if (match[index + 1] !== undefined) {
                    try {
                        params[key.name] = decodeURIComponent(match[index + 1]);
                    } catch (e) {
                        params[key.name] = match[index + 1];
                    }
                }
            });
        }

        const route = {
            name: record?.name || null,
            path: location.path || '/',
            hash: location.hash || '',
            query: location.query || {},
            params: { ...location.params, ...params },
            fullPath: this.getFullPath(location),
            matched: record ? this.getMatchedRecords(record) : []
        };

        if (location.redirectedFrom) {
            route.redirectedFrom = location.redirectedFrom;
        }

        return Object.freeze(route);
    }

    getMatchedRecords(record) {
        const matched = [];
        let current = record;
        const visited = new WeakSet();
        let depth = 0;
        
        while (current && depth < 20) {
            if (visited.has(current)) {
                console.warn('[RouteMatcher] Circular reference in route hierarchy');
                break;
            }
            
            visited.add(current);
            matched.unshift(current);
            current = current.parent;
            depth++;
        }
        return matched;
    }

    getFullPath(location) {
        const { path, query, hash } = location;
        const queryString = this.stringifyQuery(query);
        return (path || '/') + queryString + (hash || '');
    }

    normalizeLocation(raw, current) {
        if (!raw) return null;
        
        let next = typeof raw === 'string' ? { path: raw } : { ...raw };
        
        if (next.name || next._normalized) {
            return next;
        }

        if (!next.path && next.params && current) {
            next._normalized = true;
            const params = { ...current.params, ...next.params };
            if (current.name) {
                next.name = current.name;
                next.params = params;
            } else if (current.matched && current.matched.length) {
                const rawPath = current.matched[current.matched.length - 1].path;
                next.path = this.fillParams(rawPath, params);
            }
        }

        const parsedPath = this.parsePath(next.path || '/');
        const basePath = current?.path || '/';

        const path = parsedPath.path
            ? this.resolvePath(parsedPath.path, basePath)
            : basePath;

        return {
            _normalized: true,
            path,
            query: { ...next.query, ...parsedPath.query },
            hash: next.hash || parsedPath.hash || '',
            params: next.params || {}
        };
    }

    parsePath(path) {
        if (!path || typeof path !== 'string') {
            return { path: '/', query: {}, hash: '' };
        }
        
        let hash = '';
        let query = {};
        let cleanPath = path;
        
        const hashIndex = cleanPath.indexOf('#');
        if (hashIndex >= 0) {
            hash = cleanPath.slice(hashIndex);
            cleanPath = cleanPath.slice(0, hashIndex);
        }

        const queryIndex = cleanPath.indexOf('?');
        if (queryIndex >= 0) {
            const queryString = cleanPath.slice(queryIndex + 1);
            cleanPath = cleanPath.slice(0, queryIndex);
            query = this.parseQuery(queryString);
        }

        return {
            path: cleanPath || '/',
            query,
            hash
        };
    }

    parseQuery(queryString) {
        if (!queryString) return {};
        
        try {
            const params = new URLSearchParams(queryString);
            const result = {};
            for (const [key, value] of params) {
                if (key && key.length < 100) {
                    result[key] = value.length < 1000 ? value : value.slice(0, 1000);
                }
            }
            return result;
        } catch (e) {
            console.warn('[RouteMatcher] Failed to parse query string:', queryString);
            return {};
        }
    }

    stringifyQuery(query) {
        if (!query || typeof query !== 'object') return '';
        
        try {
            const params = new URLSearchParams();
            Object.keys(query).forEach(key => {
                if (query[key] !== null && query[key] !== undefined) {
                    params.append(key, String(query[key]));
                }
            });
            const str = params.toString();
            return str ? `?${str}` : '';
        } catch (e) {
            console.warn('[RouteMatcher] Failed to stringify query:', query);
            return '';
        }
    }

    resolvePath(relative, base) {
        if (!relative || !base) return '/';
        
        if (relative.charAt(0) === '/') {
            return relative;
        }

        if (relative.charAt(0) === '?' || relative.charAt(0) === '#') {
            return base + relative;
        }

        const stack = base.split('/');
        const segments = relative.split('/');

        stack.pop();

        for (let i = 0; i < segments.length; i++) {
            const segment = segments[i];
            if (segment === '..') {
                stack.pop();
            } else if (segment !== '.') {
                stack.push(segment);
            }
        }

        if (stack[0] !== '') {
            stack.unshift('');
        }

        return stack.join('/');
    }

    fillParams(path, params) {
        if (!path || !params) return path;
        
        return path.replace(/:([^/]+)/g, (match, key) => {
            return params[key] || match;
        });
    }

    addRoute(parentOrRoute, route) {
        if (this._destroyed) return;
        
        if (route) {
            const parent = this.nameMap.get(parentOrRoute) || this.pathMap.get(parentOrRoute);
            this.addRouteRecord(route, parent);
        } else {
            this.addRouteRecord(parentOrRoute);
        }
    }

    addRoutes(routes) {
        if (this._destroyed) return;
        this.createRouteMap(routes);
    }

    getRoutes() {
        return this._destroyed ? [] : Array.from(this.pathMap.values());
    }

    destroy() {
        this._destroyed = true;
        
        for (const record of this._routeRecords) {
            record.destroy();
        }
        
        this.pathList = [];
        this.pathMap.clear();
        this.nameMap.clear();
        this._routeRecords.clear();
    }
}

// 历史管理基类 - 修复内存泄漏和并发问题
class History {
    constructor(router) {
        this.router = router;
        this.base = router.base;
        this.current = this.createStartRoute();
        this.pending = null;
        this.ready = false;
        this.readyCbs = [];
        this.readyErrorCbs = [];
        this.errorCbs = [];
        this.listeners = [];
        this.transitioning = false;
        this._destroyed = false;
        
        this._transitionQueue = [];
        this._isProcessingQueue = false;
        
        this._cleanupTimer = setInterval(() => {
            this._cleanupCallbacks();
        }, 60000);
    }

    createStartRoute() {
        return this.router.matcher.createRoute(null, { path: '/' });
    }

    listen(cb) {
        this.cb = cb;
    }

    onReady(cb, errorCb) {
        if (this._destroyed) return;
        
        if (this.ready) {
            try {
                cb();
            } catch (error) {
                console.error('[History] Ready callback error:', error);
            }
        } else {
            this.readyCbs.push(cb);
            if (errorCb) {
                this.readyErrorCbs.push(errorCb);
            }
        }
    }

    onError(errorCb) {
        if (this._destroyed) return;
        this.errorCbs.push(errorCb);
    }

    async transitionTo(location, onComplete, onAbort) {
        if (this._destroyed) {
            onAbort && onAbort(new Error('Router destroyed'));
            return;
        }
        
        return new Promise((resolve, reject) => {
            this._transitionQueue.push({
                location,
                onComplete: (route) => {
                    onComplete && onComplete(route);
                    resolve(route);
                },
                onAbort: (err) => {
                    onAbort && onAbort(err);
                    reject(err);
                }
            });
            
            this._processTransitionQueue();
        });
    }

    async _processTransitionQueue() {
        if (this._isProcessingQueue || this._transitionQueue.length === 0) {
            return;
        }
        
        this._isProcessingQueue = true;
        
        while (this._transitionQueue.length > 0) {
            const transition = this._transitionQueue.shift();
            try {
                await this._performTransition(transition);
            } catch (error) {
                transition.onAbort && transition.onAbort(error);
            }
        }
        
        this._isProcessingQueue = false;
    }

    async _performTransition({ location, onComplete, onAbort }) {
        if (this._destroyed) {
            onAbort && onAbort(new Error('Router destroyed'));
            return;
        }
        
        try {
            const route = this.router.matcher.match(location, this.current);
            
            await new Promise((resolve, reject) => {
                this.confirmTransition(route, () => {
                    this.current = route;
                    this.cb && this.cb(route);
                    onComplete && onComplete(route);
                    
                    this.router.afterHooks.forEach(hook => {
                        try {
                            hook && hook(route, this.current);
                        } catch (error) {
                            console.error('[History] After hook error:', error);
                        }
                    });

                    if (!this.ready) {
                        this.ready = true;
                        this._executeCallbacks(this.readyCbs, route);
                    }
                    
                    resolve();
                }, err => {
                    if (err && !this.ready) {
                        this.ready = true;
                        this._executeCallbacks(this.readyErrorCbs, err);
                    }
                    reject(err);
                });
            });
        } catch (error) {
            console.error('[History] Transition error:', error);
            onAbort && onAbort(error);
        }
    }

    _executeCallbacks(callbacks, ...args) {
        const callbacksCopy = [...callbacks];
        callbacks.length = 0;
        
        callbacksCopy.forEach(cb => {
            try {
                cb(...args);
            } catch (error) {
                console.error('[History] Callback error:', error);
            }
        });
    }

    confirmTransition(route, onComplete, onAbort) {
        const current = this.current;
        
        const abort = err => {
            if (err && err instanceof Error && err.type !== NavigationFailureType.DUPLICATED) {
                if (this.errorCbs.length) {
                    this._executeCallbacks(this.errorCbs, err);
                } else {
                    console.error(err);
                }
            }
            onAbort && onAbort(err);
        };

        if (this.isSameRoute(route, current)) {
            onComplete && onComplete(current);
            return;
        }

        const queue = [...this.router.beforeHooks];
        this.pending = route;
        
        const iterator = (hook, next) => {
            if (this.pending !== route) {
                return abort(new NavigationCancelled(current, route));
            }
            
            try {
                hook(route, current, (to) => {
                    if (to === false || (to instanceof Error)) {
                        abort(to);
                    } else if (typeof to === 'string' || (typeof to === 'object' && (typeof to.path === 'string' || typeof to.name === 'string'))) {
                        abort();
                        if (typeof to === 'object' && to.replace) {
                            this.replace(to);
                        } else {
                            this.push(to);
                        }
                    } else {
                        next(to);
                    }
                });
            } catch (e) {
                abort(e);
            }
        };

        this.runQueue(queue, iterator, () => {
            if (this.pending !== route) {
                return abort(new NavigationCancelled(current, route));
            }
            this.pending = null;
            onComplete(route);
        });
    }

    runQueue(queue, fn, cb) {
        const step = index => {
            if (index >= queue.length) {
                cb();
            } else {
                if (queue[index]) {
                    fn(queue[index], () => {
                        step(index + 1);
                    });
                } else {
                    step(index + 1);
                }
            }
        };
        step(0);
    }

    isSameRoute(a, b) {
        if (!a || !b) return false;
        if (b === this.router.matcher.START_LOCATION) {
            return a === b;
        }
        
        const normalizePath = (path) => {
            if (!path) return '/';
            return path.replace(/\/+$/, '') || '/';
        };
        
        const pathA = normalizePath(a.path);
        const pathB = normalizePath(b.path);
        
        if (a.path && b.path) {
            return pathA === pathB &&
                   a.hash === b.hash &&
                   this.isObjectEqual(a.query, b.query) &&
                   this.isObjectEqual(a.params, b.params);
        } else if (a.name && b.name) {
            return a.name === b.name &&
                   this.isObjectEqual(a.query, b.query) &&
                   this.isObjectEqual(a.params, b.params);
        }
        return false;
    }

    isObjectEqual(a = {}, b = {}) {
        const aKeys = Object.keys(a);
        const bKeys = Object.keys(b);
        if (aKeys.length !== bKeys.length) {
            return false;
        }
        return aKeys.every(key => String(a[key]) === String(b[key]));
    }

    _cleanupCallbacks() {
        const maxCallbacks = 100;
        
        if (this.readyCbs.length > maxCallbacks) {
            this.readyCbs.splice(maxCallbacks);
        }
        if (this.readyErrorCbs.length > maxCallbacks) {
            this.readyErrorCbs.splice(maxCallbacks);
        }
        if (this.errorCbs.length > maxCallbacks) {
            this.errorCbs.splice(maxCallbacks);
        }
    }

    destroy() {
        this._destroyed = true;
        
        if (this._cleanupTimer) {
            clearInterval(this._cleanupTimer);
            this._cleanupTimer = null;
        }
        
        this.listeners.forEach(cleanup => {
            try {
                cleanup();
            } catch (error) {
                console.error('[History] Cleanup error:', error);
            }
        });
        this.listeners = [];
        
        this.readyCbs = [];
        this.readyErrorCbs = [];
        this.errorCbs = [];
        this._transitionQueue = [];
        
        this.cb = null;
        this.current = null;
        this.pending = null;
    }
}

// Hash 模式历史管理 - 修复双重触发
class HashHistory extends History {
    constructor(router) {
        super(router);
        this.listenersSetup = false;
        this.isProgrammaticNavigation = false;
        this._navigationTimeout = null;
    }

    setupListeners() {
        if (this.listenersSetup || this._destroyed) return;
        this.listenersSetup = true;

        let lastHash = this.getHash();
        
        const handleRoutingEvent = () => {
            if (this._destroyed) return;
            
            if (this._navigationTimeout) {
                clearTimeout(this._navigationTimeout);
            }
            
            this._navigationTimeout = setTimeout(() => {
                const currentHash = this.getHash();
                
                if (this.isProgrammaticNavigation) {
                    this.isProgrammaticNavigation = false;
                    lastHash = currentHash;
                    return;
                }
                
                if (currentHash === lastHash) {
                    return;
                }
                
                if (!this.ensureSlash()) {
                    return;
                }
                
                const currentPath = this.current.fullPath;
                
                if (currentHash && currentHash !== currentPath) {
                    lastHash = currentHash;
                    this.transitionTo(currentHash).catch(err => {
                        if (err.type !== NavigationFailureType.DUPLICATED) {
                            console.error('[HashHistory] Navigation error:', err);
                        }
                    });
                }
            }, 50);
        };

        window.addEventListener('hashchange', handleRoutingEvent, { passive: true });
        this.listeners.push(() => {
            window.removeEventListener('hashchange', handleRoutingEvent);
            if (this._navigationTimeout) {
                clearTimeout(this._navigationTimeout);
                this._navigationTimeout = null;
            }
        });
    }

    push(location, onComplete, onAbort) {
        this.transitionTo(location, route => {
            this.isProgrammaticNavigation = true;
            this.pushHash(route.fullPath);
            onComplete && onComplete(route);
        }, onAbort);
    }

    replace(location, onComplete, onAbort) {
        this.transitionTo(location, route => {
            this.isProgrammaticNavigation = true;
            this.replaceHash(route.fullPath);
            onComplete && onComplete(route);
        }, onAbort);
    }

    go(n) {
        if (typeof n === 'number' && Math.abs(n) <= 100) {
            window.history.go(n);
        }
    }

    ensureSlash() {
        const path = this.getHash();
        if (path.charAt(0) === '/') {
            return true;
        }
        this.isProgrammaticNavigation = true;
        this.replaceHash('/' + path);
        return false;
    }

    getHash() {
        let href = window.location.href;
        const index = href.indexOf('#');
        if (index < 0) return '';

        href = href.slice(index + 1);
        return href;
    }

    getUrl(path) {
        const href = window.location.href;
        const i = href.indexOf('#');
        const base = i >= 0 ? href.slice(0, i) : href;
        return `${base}#${path}`;
    }

    pushHash(path) {
        if (path && typeof path === 'string') {
            try {
                window.location.hash = path;
            } catch (error) {
                console.error('[HashHistory] Push hash error:', error);
            }
        }
    }

    replaceHash(path) {
        if (path && typeof path === 'string') {
            try {
                window.location.replace(this.getUrl(path));
            } catch (error) {
                console.error('[HashHistory] Replace hash error:', error);
                window.location.hash = path;
            }
        }
    }

    getCurrentLocation() {
        return this.getHash();
    }
}

// HTML5 模式历史管理 - 优化滚动处理
class HTML5History extends History {
    constructor(router) {
        super(router);
        this._scrollPositions = new Map();
        this._maxScrollPositions = 50;
    }

    setupListeners() {
        if (this.listeners.length > 0 || this._destroyed) return;

        const router = this.router;
        const expectScroll = router.options.scrollBehavior;

        const handlePopState = e => {
            if (this._destroyed) return;
            
            const current = this.current;
            const location = this.getCurrentLocation();

            this.transitionTo(location, route => {
                if (expectScroll) {
                    this.handleScroll(router, route, current, true);
                }
            }, err => {
                if (err && err.type !== NavigationFailureType.DUPLICATED) {
                    console.error('[HTML5History] PopState navigation error:', err);
                }
            });
        };

        const handleScroll = () => {
            if (this._destroyed) return;
            
            const key = this.current.fullPath;
            if (this._scrollPositions.size >= this._maxScrollPositions) {
                const firstKey = this._scrollPositions.keys().next().value;
                this._scrollPositions.delete(firstKey);
            }
            this._scrollPositions.set(key, {
                x: window.pageXOffset,
                y: window.pageYOffset
            });
        };

        window.addEventListener('popstate', handlePopState, { passive: true });
        window.addEventListener('scroll', handleScroll, { passive: true });
        
        this.listeners.push(() => {
            window.removeEventListener('popstate', handlePopState);
            window.removeEventListener('scroll', handleScroll);
        });
    }

    push(location, onComplete, onAbort) {
        const { current: fromRoute } = this;
        this.transitionTo(location, route => {
            this.pushState(this.cleanPath(this.base + route.fullPath));
            this.handleScroll(this.router, route, fromRoute, false);
            onComplete && onComplete(route);
        }, onAbort);
    }

    replace(location, onComplete, onAbort) {
        const { current: fromRoute } = this;
        this.transitionTo(location, route => {
            this.replaceState(this.cleanPath(this.base + route.fullPath));
            this.handleScroll(this.router, route, fromRoute, false);
            onComplete && onComplete(route);
        }, onAbort);
    }

    go(n) {
        if (typeof n === 'number' && Math.abs(n) <= 100) {
            window.history.go(n);
        }
    }

    pushState(url, replace) {
        try {
            const history = window.history;
            const state = { 
                key: Date.now(),
                position: this._scrollPositions.get(this.current.fullPath)
            };
            if (replace) {
                history.replaceState(state, '', url);
            } else {
                history.pushState(state, '', url);
            }
        } catch (e) {
            console.warn('[HTML5History] PushState failed, fallback to location change');
            window.location[replace ? 'replace' : 'assign'](url);
        }
    }

    replaceState(url) {
        this.pushState(url, true);
    }

    getCurrentLocation() {
        return this.getLocation(this.base);
    }

    getLocation(base) {
        let path = window.location.pathname;
        try {
            path = decodeURI(path);
        } catch (e) {
            console.warn('[HTML5History] Failed to decode pathname');
        }
        
        if (base && path.toLowerCase().indexOf(base.toLowerCase()) === 0) {
            path = path.slice(base.length);
        }
        return (path || '/') + window.location.search + window.location.hash;
    }

    cleanPath(path) {
        return path.replace(/\/+/g, '/');
    }

    handleScroll(router, to, from, isPop) {
        if (!router.options.scrollBehavior) return;
        
        if (isPop) {
            const savedPosition = this._scrollPositions.get(to.fullPath);
            if (savedPosition) {
                this.scrollToPosition(savedPosition);
                return;
            }
        }
        
        try {
            const behavior = router.options.scrollBehavior(to, from, isPop ? { x: window.pageXOffset, y: window.pageYOffset } : null);
            if (!behavior) return;

            if (typeof behavior.then === 'function') {
                behavior.then(position => {
                    this.scrollToPosition(position);
                }).catch(err => {
                    console.error('[HTML5History] Scroll behavior error:', err);
                });
            } else {
                this.scrollToPosition(behavior);
            }
        } catch (error) {
            console.error('[HTML5History] Scroll handling error:', error);
        }
    }

    scrollToPosition(position) {
        if (!position) return;
        
        try {
            if (typeof position === 'object') {
                if (typeof position.selector === 'string') {
                    const el = document.querySelector(position.selector);
                    if (el) {
                        el.scrollIntoView(position);
                    }
                } else if (typeof position.x === 'number' || typeof position.y === 'number') {
                    window.scrollTo(position.x || 0, position.y || 0);
                }
            }
        } catch (error) {
            console.error('[HTML5History] Scroll to position error:', error);
        }
    }

    destroy() {
        super.destroy();
        this._scrollPositions.clear();
    }
}

// 主路由器类 - 完善资源管理
class Router extends EventEmitter {
    constructor(options = {}) {
        super();
        
        this.options = { ...options };
        this.mode = options.mode || RouterMode.HASH;
        this.base = this._normalizeBase(options.base);
        this.fallback = options.fallback !== false;
        
        this.matcher = new RouteMatcher(options.routes || []);
        this.current = this.matcher.createRoute(null, { path: '/' });
        
        this.pending = null;
        this.ready = false;
        this.readyCbs = [];
        this.readyErrorCbs = [];
        this.errorCbs = [];
        
        this.cache = new RouteCache(options.cacheSize || 50);
        
        this.beforeHooks = [];
        this.resolveHooks = [];
        this.afterHooks = [];
        
        this.apps = new Set();
        this.history = this.createHistory();
        
        this.initialized = false;
        this._destroyed = false;
        
        this._cacheCleanupTimer = setInterval(() => {
            this.cache.cleanup();
        }, 5 * 60 * 1000);
        
        this._handleVisibilityChange = () => {
            if (document.hidden) {
                this.cache.cleanup(10 * 60 * 1000);
            }
        };
        
        if (typeof document !== 'undefined') {
            document.addEventListener('visibilitychange', this._handleVisibilityChange);
        }
    }

    _normalizeBase(base) {
        if (!base) return '/';
        if (base.charAt(0) !== '/') base = '/' + base;
        return base.replace(/\/$/, '') || '/';
    }

    createHistory() {
        switch (this.mode) {
            case RouterMode.HISTORY:
                return new HTML5History(this);
            case RouterMode.HASH:
                return new HashHistory(this);
            default:
                return new HashHistory(this);
        }
    }

    init() {
        if (this.initialized || this._destroyed) return;
        this.initialized = true;
        
        const history = this.history;
        const currentLocation = history.getCurrentLocation() || '/';
        const initialRoute = this.matcher.match(currentLocation, this.current);
        this.current = initialRoute;
        
        const setupListeners = () => {
            if (!this._destroyed) {
                history.setupListeners();
            }
        };

        if (currentLocation !== '/') {
            history.transitionTo(currentLocation, setupListeners, setupListeners);
        } else {
            setupListeners();
            if (history.cb && !this._destroyed) {
                history.cb(this.current);
            }
        }

        history.listen(route => {
            if (this._destroyed) return;
            
            this.current = route;
            this.apps.forEach(app => {
                try {
                    if (app && typeof app.updateRoute === 'function') {
                        app.updateRoute(route);
                    } else if (app) {
                        app._route = route;
                    }
                } catch (error) {
                    console.error('[Router] App update error:', error);
                }
            });
        });

        this.initCustomElements();
        this.initProgressBar();
        
        log('路由器已初始化');
    }

    beforeEach(fn) {
        if (typeof fn === 'function' && !this._destroyed) {
            return this.registerHook(this.beforeHooks, fn);
        }
        return () => {};
    }

    beforeResolve(fn) {
        if (typeof fn === 'function' && !this._destroyed) {
            return this.registerHook(this.resolveHooks, fn);
        }
        return () => {};
    }

    afterEach(fn) {
        if (typeof fn === 'function' && !this._destroyed) {
            return this.registerHook(this.afterHooks, fn);
        }
        return () => {};
    }

    registerHook(list, fn) {
        if (this._destroyed) return () => {};
        
        if (list.length >= 100) {
            console.warn('[Router] Too many hooks registered, ignoring new hook');
            return () => {};
        }
        
        list.push(fn);
        return () => {
            const i = list.indexOf(fn);
            if (i > -1) list.splice(i, 1);
        };
    }

    push(location, onComplete, onAbort) {
        if (!location || this._destroyed) {
            onAbort && onAbort(new Error('Invalid location or router destroyed'));
            return Promise.reject(new Error('Invalid location or router destroyed'));
        }
        
        if (!onComplete && !onAbort && typeof Promise !== 'undefined') {
            return new Promise((resolve, reject) => {
                this.history.push(location, resolve, reject);
            });
        } else {
            return this.history.push(location, onComplete, onAbort);
        }
    }

    replace(location, onComplete, onAbort) {
        if (!location || this._destroyed) {
            onAbort && onAbort(new Error('Invalid location or router destroyed'));
            return Promise.reject(new Error('Invalid location or router destroyed'));
        }
        
        if (!onComplete && !onAbort && typeof Promise !== 'undefined') {
            return new Promise((resolve, reject) => {
                this.history.replace(location, resolve, reject);
            });
        } else {
            return this.history.replace(location, onComplete, onAbort);
        }
    }

    go(n) {
        if (!this._destroyed) {
            this.history.go(n);
        }
    }

    back() {
        this.go(-1);
    }

    forward() {
        this.go(1);
    }

    resolve(to, current, append) {
        if (this._destroyed) {
            return { location: null, route: null, href: '', normalizedTo: null, resolved: null };
        }
        
        current = current || this.current;
        const location = this.matcher.normalizeLocation(to, current);
        const route = this.matcher.match(location, current);
        const fullPath = route.fullPath || location.path;
        
        return {
            location,
            route,
            href: fullPath,
            normalizedTo: location,
            resolved: route
        };
    }

    addRoute(parentOrRoute, route) {
        if (this._destroyed) return;
        
        this.matcher.addRoute(parentOrRoute, route);
        if (this.current !== this.matcher.START_LOCATION) {
            this.history.transitionTo(this.history.getCurrentLocation()).catch(err => {
                if (err.type !== NavigationFailureType.DUPLICATED) {
                    console.error('[Router] Add route transition error:', err);
                }
            });
        }
    }

    addRoutes(routes) {
        if (this._destroyed) return;
        
        this.matcher.addRoutes(routes);
        if (this.current !== this.matcher.START_LOCATION) {
            this.history.transitionTo(this.history.getCurrentLocation()).catch(err => {
                if (err.type !== NavigationFailureType.DUPLICATED) {
                    console.error('[Router] Add routes transition error:', err);
                }
            });
        }
    }

    getRoutes() {
        return this._destroyed ? [] : this.matcher.getRoutes();
    }

    async loadComponent(path, maxRetries = 2) {
        if (this._destroyed) {
            throw new Error('Router destroyed');
        }
        
        if (this.cache.has(path)) {
            return this.cache.get(path);
        }

        this.showProgressBar();
        let lastError;
        let controller = new AbortController();

        try {
            for (let attempt = 0; attempt <= maxRetries; attempt++) {
                try {
                    if (attempt > 0) {
                        controller = new AbortController();
                    }
                    
                    const timeoutId = setTimeout(() => controller.abort(), 10000);

                    const response = await fetch(path, {
                        signal: controller.signal,
                        cache: 'default',
                        headers: {
                            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
                        }
                    });
                    
                    clearTimeout(timeoutId);

                    if (!response.ok) {
                        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
                    }

                    const content = await response.text();
                    
                    if (!this._destroyed) {
                        this.cache.set(path, content);
                    }
                    
                    this.hideProgressBar();
                    return content;

                } catch (error) {
                    lastError = error;
                    if (error.name === 'AbortError') {
                        throw new Error('Request timeout');
                    }
                    if (attempt < maxRetries) {
                        await new Promise(resolve => setTimeout(resolve, Math.min(1000 * Math.pow(2, attempt), 5000)));
                    }
                }
            }
        } finally {
            this.hideProgressBar();
            controller.abort();
        }

        throw lastError || new Error('Component load failed');
    }

    initProgressBar() {
        if (typeof document === 'undefined' || document.getElementById('router-progress')) return;
        
        const bar = document.createElement('div');
        bar.id = 'router-progress';
        bar.style.cssText = `
            position: fixed !important;
            top: 0 !important;
            left: 0 !important;
            right: 0 !important;
            height: 3px !important;
            background: linear-gradient(90deg, #4a90e2, #42b983) !important;
            width: 0 !important;
            z-index: 9999 !important;
            transition: width 0.3s ease, opacity 0.3s ease !important;
            opacity: 0 !important;
            box-shadow: 0 0 10px rgba(74, 144, 226, 0.5) !important;
            will-change: width, opacity !important;
        `;
        document.body.appendChild(bar);
    }

    showProgressBar() {
        if (typeof document === 'undefined') return;
        
        const bar = document.getElementById('router-progress');
        if (bar) {
            requestAnimationFrame(() => {
                bar.style.width = '70%';
                bar.style.opacity = '1';
            });
        }
    }

    hideProgressBar() {
        if (typeof document === 'undefined') return;
        
        const bar = document.getElementById('router-progress');
        if (bar) {
            requestAnimationFrame(() => {
                bar.style.width = '100%';
                setTimeout(() => {
                    bar.style.opacity = '0';
                    setTimeout(() => bar.style.width = '0', 300);
                }, 100);
            });
        }
    }

    initCustomElements() {
        if (typeof customElements === 'undefined') return;
        
        try {
            this.defineRouterLink();
            this.defineRouterView();
        } catch (error) {
            console.error('[Router] Custom elements initialization error:', error);
        }
    }

    defineRouterLink() {
        if (customElements.get('router-link')) return;

        const router = this;
        
        class RouterLinkElement extends HTMLElement {
            constructor() {
                super();
                this.handleClick = this.handleClick.bind(this);
                this._destroyed = false;
            }

            connectedCallback() {
                if (this._destroyed) return;
                
                this.addEventListener('click', this.handleClick);
                this.render();
                this.updateActiveClass();
            }

            disconnectedCallback() {
                this._destroyed = true;
                this.removeEventListener('click', this.handleClick);
            }

            handleClick(e) {
                if (this._destroyed || router._destroyed) return;
                
                if (this.shouldPreventDefault(e)) {
                    e.preventDefault();
                    const to = this.getAttribute('to');
                    const replace = this.hasAttribute('replace');
                    
                    if (to) {
                        try {
                            if (replace) {
                                router.replace(to);
                            } else {
                                router.push(to);
                            }
                        } catch (error) {
                            console.error('[RouterLink] Navigation error:', error);
                        }
                    }
                }
            }

            shouldPreventDefault(e) {
                if (e.metaKey || e.altKey || e.ctrlKey || e.shiftKey) return false;
                if (e.defaultPrevented) return false;
                if (e.button !== undefined && e.button !== 0) return false;
                if (this.getAttribute('target') === '_blank') return false;
                return true;
            }

            render() {
                if (this._destroyed) return;
                
                const to = this.getAttribute('to');
                const tag = this.getAttribute('tag') || 'a';

                if (tag === 'a' && to) {
                    this.setAttribute('href', '#' + to);
                }
            }

            updateActiveClass() {
                if (this._destroyed || router._destroyed) return;
                
                const to = this.getAttribute('to');
                const activeClass = this.getAttribute('active-class') || 'router-link-active';
                const exactActiveClass = this.getAttribute('exact-active-class') || 'router-link-exact-active';

                if (to && router.current) {
                    const current = router.current.path;
                    const isActive = current.startsWith(to) && to !== '/';
                    const isExactActive = current === to;

                    this.classList.toggle(activeClass, isActive || isExactActive);
                    this.classList.toggle(exactActiveClass, isExactActive);
                }
            }
        }

        customElements.define('router-link', RouterLinkElement);
    }

    defineRouterView() {
        if (customElements.get('router-view')) return;

        const router = this;
        
        class RouterViewElement extends HTMLElement {
            constructor() {
                super();
                this.name = this.getAttribute('name') || 'default';
                this._route = router.current;
                this.isRendering = false;
                this._destroyed = false;
                this._renderController = null;
                router.apps.add(this);
            }

            connectedCallback() {
                if (!this._destroyed) {
                    this.render();
                }
            }

            disconnectedCallback() {
                this._destroyed = true;
                if (this._renderController) {
                    this._renderController.abort();
                }
                router.apps.delete(this);
            }

            updateRoute(route) {
                if (this._destroyed) return;
                
                if (this._route !== route) {
                    this._route = route;
                    this.render();
                }
            }

            async render() {
                if (this.isRendering || this._destroyed) return;
                this.isRendering = true;
                
                if (this._renderController) {
                    this._renderController.abort();
                }
                this._renderController = new AbortController();
                
                try {
                    const route = this._route;
                    if (!route || !route.matched || route.matched.length === 0) {
                        this.innerHTML = '';
                        this.updateAllRouterLinks();
                        return;
                    }

                    const matched = route.matched[route.matched.length - 1];
                    
                    if (!matched) {
                        this.innerHTML = '';
                        this.updateAllRouterLinks();
                        return;
                    }

                    const component = matched.components
                        ? matched.components[this.name]
                        : matched.component;

                    if (!component) {
                        this.innerHTML = '';
                        this.updateAllRouterLinks();
                        return;
                    }

                    let content;
                    if (typeof component === 'function') {
                        const result = component(route.params);
                        content = result instanceof Promise ? await result : result;
                    } else if (typeof component === 'string') {
                        content = component;
                    } else {
                        content = component;
                    }

                    if (this._renderController.signal.aborted || this._destroyed) {
                        return;
                    }

                    if (typeof content === 'string') {
                        this.innerHTML = content;
                    } else if (content instanceof HTMLElement) {
                        this.innerHTML = '';
                        this.appendChild(content);
                    }
                    
                    if (matched.meta && matched.meta.title && typeof document !== 'undefined') {
                        document.title = typeof matched.meta.title === 'function'
                            ? matched.meta.title(route)
                            : matched.meta.title;
                    }

                    this.updateAllRouterLinks();

                } catch (error) {
                    if (!this._renderController.signal.aborted && !this._destroyed) {
                        console.error('[RouterView] 渲染失败:', error);
                        this.innerHTML = '<div class="error">页面加载失败</div>';
                    }
                } finally {
                    this.isRendering = false;
                    this._renderController = null;
                }
            }

            updateAllRouterLinks() {
                if (this._destroyed || typeof document === 'undefined') return;
                
                requestAnimationFrame(() => {
                    if (this._destroyed) return;
                    
                    try {
                        document.querySelectorAll('router-link').forEach(link => {
                            if (link.updateActiveClass && typeof link.updateActiveClass === 'function') {
                                link.updateActiveClass();
                            }
                        });
                    } catch (error) {
                        console.error('[RouterView] Update router links error:', error);
                    }
                });
            }
        }

        customElements.define('router-view', RouterViewElement);
    }

    onReady(cb, errorCb) {
        if (this._destroyed) return;
        
        if (this.ready) {
            try {
                cb();
            } catch (error) {
                console.error('[Router] Ready callback error:', error);
            }
        } else {
            this.readyCbs.push(cb);
            if (errorCb) {
                this.readyErrorCbs.push(errorCb);
            }
        }
    }

    onError(errorCb) {
        if (this._destroyed) return;
        this.errorCbs.push(errorCb);
    }

    destroy() {
        if (this._destroyed) return;
        this._destroyed = true;

        log('正在销毁路由器...');

        if (this._cacheCleanupTimer) {
            clearInterval(this._cacheCleanupTimer);
            this._cacheCleanupTimer = null;
        }

        if (typeof document !== 'undefined' && this._handleVisibilityChange) {
            document.removeEventListener('visibilitychange', this._handleVisibilityChange);
            this._handleVisibilityChange = null;
        }

        if (this.history) {
            this.history.destroy();
            this.history = null;
        }

        if (this.matcher) {
            this.matcher.destroy();
            this.matcher = null;
        }

        if (this.cache) {
            this.cache.destroy();
            this.cache = null;
        }

        super.destroy();

        this.apps.clear();

        this.beforeHooks = [];
        this.resolveHooks = [];
        this.afterHooks = [];
        this.readyCbs = [];
        this.readyErrorCbs = [];
        this.errorCbs = [];

        if (typeof document !== 'undefined') {
            const progressBar = document.getElementById('router-progress');
            if (progressBar && progressBar.parentNode) {
                progressBar.parentNode.removeChild(progressBar);
            }
        }

        this.current = null;
        this.pending = null;
        this.options = null;

        log('路由器已销毁');
    }
}

// 工具函数和辅助类
function createNavigationGuard(router) {
    return {
        beforeEach: (guard) => {
            if (typeof guard !== 'function') {
                console.warn('[NavigationGuard] beforeEach expects a function');
                return () => {};
            }
            return router.beforeEach((to, from, next) => {
                try {
                    guard(to, from, next);
                } catch (error) {
                    console.error('[NavigationGuard] beforeEach error:', error);
                    next(false);
                }
            });
        },
        
        beforeResolve: (guard) => {
            if (typeof guard !== 'function') {
                console.warn('[NavigationGuard] beforeResolve expects a function');
                return () => {};
            }
            return router.beforeResolve((to, from, next) => {
                try {
                    guard(to, from, next);
                } catch (error) {
                    console.error('[NavigationGuard] beforeResolve error:', error);
                    next(false);
                }
            });
        },
        
        afterEach: (guard) => {
            if (typeof guard !== 'function') {
                console.warn('[NavigationGuard] afterEach expects a function');
                return () => {};
            }
            return router.afterEach((to, from) => {
                try {
                    guard(to, from);
                } catch (error) {
                    console.error('[NavigationGuard] afterEach error:', error);
                }
            });
        },
        
        beforeEnter: (to, from, next) => next(),
        beforeRouteEnter: (to, from, next) => next(),
        beforeRouteUpdate: (to, from, next) => next(),
        beforeRouteLeave: (to, from, next) => next()
    };
}

// 创建路由器实例的工厂函数
function createRouter(options = {}) {
    if (typeof options !== 'object') {
        throw new Error('Router options must be an object');
    }
    
    const defaultOptions = {
        mode: RouterMode.HASH,
        base: '/',
        routes: [],
        fallback: true,
        cacheSize: 50,
        scrollBehavior: null
    };
    
    const mergedOptions = { ...defaultOptions, ...options };
    
    // 验证路由配置
    if (mergedOptions.routes && !Array.isArray(mergedOptions.routes)) {
        throw new Error('Routes must be an array');
    }
    
    // 验证模式
    if (!Object.values(RouterMode).includes(mergedOptions.mode)) {
        console.warn(`[Router] Invalid mode "${mergedOptions.mode}", fallback to hash mode`);
        mergedOptions.mode = RouterMode.HASH;
    }
    
    // 在不支持 history API 的环境中降级到 hash 模式
    if (mergedOptions.mode === RouterMode.HISTORY && 
        typeof window !== 'undefined' && 
        !window.history.pushState && 
        mergedOptions.fallback) {
        mergedOptions.mode = RouterMode.HASH;
        console.warn('[Router] History mode not supported, fallback to hash mode');
    }
    
    const router = new Router(mergedOptions);
    
    // 添加全局错误处理
    if (typeof window !== 'undefined') {
        window.addEventListener('unhandledrejection', event => {
            if (event.reason && event.reason.name && 
                event.reason.name.includes('Navigation')) {
                event.preventDefault();
                console.warn('[Router] Unhandled navigation rejection:', event.reason);
            }
        });
    }
    
    return router;
}

// 辅助函数
function isNavigationFailure(error, ...types) {
    return error instanceof Error && 
           error.type && 
           Object.values(NavigationFailureType).includes(error.type) &&
           (types.length === 0 || types.includes(error.type));
}

function createWebHistory(base) {
    return {
        mode: RouterMode.HISTORY,
        base: base || '/'
    };
}

function createWebHashHistory(base) {
    return {
        mode: RouterMode.HASH,
        base: base || '/'
    };
}

function createMemoryHistory(base) {
    return {
        mode: RouterMode.ABSTRACT,
        base: base || '/'
    };
}

// 路由组合工具
function useRouter() {
    if (typeof window !== 'undefined' && window.__ROUTER_INSTANCE__) {
        return window.__ROUTER_INSTANCE__;
    }
    throw new Error('useRouter() can only be used inside router context');
}

function useRoute() {
    const router = useRouter();
    return router.current;
}

// 设置全局路由器实例
function setGlobalRouter(router) {
    if (typeof window !== 'undefined') {
        window.__ROUTER_INSTANCE__ = router;
    }
}

// 导出所有需要的类和函数
export {
    // 主要类
    Router,
    
    // 枚举
    RouterMode,
    NavigationType,
    NavigationFailureType,
    
    // 错误类
    NavigationDuplicated,
    NavigationAborted,
    NavigationCancelled,
    
    // 工厂函数
    createRouter,
    createNavigationGuard,
    
    // 历史模式创建函数
    createWebHistory,
    createWebHashHistory,
    createMemoryHistory,
    
    // 辅助函数
    isNavigationFailure,
    useRouter,
    useRoute,
    setGlobalRouter
};

// 默认导出
export default createRouter;