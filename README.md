# 高级JavaScript路由器使用指南

## 目录

1. [快速开始](#快速开始)
2. [路由配置](#路由配置)
3. [路由模式](#路由模式)
4. [API 参考](#api-参考)
5. [导航守卫](#导航守卫)
6. [自定义元素](#自定义元素)
7. [错误处理](#错误处理)
8. [性能优化](#性能优化)
9. [高级功能](#高级功能)
10. [最佳实践](#最佳实践)

## 快速开始

### 安装和基本设置

```javascript
import { createRouter, RouterMode } from './router.js';

// 定义路由
const routes = [
  { path: '/', component: '<h1>首页</h1>' },
  { path: '/about', component: '<h1>关于我们</h1>' },
  { path: '/user/:id', component: (params) => `<h1>用户ID: ${params.id}</h1>` }
];

// 创建路由器实例
const router = createRouter({
  mode: RouterMode.HASH,
  routes: routes
});

// 初始化路由器
router.init();
```

### HTML 结构

```html
<!DOCTYPE html>
<html>
<head>
    <title>我的应用</title>
</head>
<body>
    <nav>
        <router-link to="/">首页</router-link>
        <router-link to="/about">关于</router-link>
        <router-link to="/user/123">用户123</router-link>
    </nav>
    
    <main>
        <router-view></router-view>
    </main>
    
    <script type="module" src="app.js"></script>
</body>
</html>
```

## 路由配置

### 基本路由配置

```javascript
const routes = [
  {
    path: '/',
    name: 'home',
    component: '<div>首页内容</div>',
    meta: { title: '首页', requiresAuth: false }
  },
  {
    path: '/user/:id',
    name: 'user',
    component: (params) => `<div>用户 ${params.id}</div>`,
    props: true,
    meta: { title: '用户详情' }
  },
  {
    path: '/admin',
    component: '<div>管理后台</div>',
    beforeEnter: (to, from, next) => {
      // 路由独享守卫
      if (checkPermission()) {
        next();
      } else {
        next('/login');
      }
    }
  }
];
```

### 嵌套路由

```javascript
const routes = [
  {
    path: '/user',
    component: '<div>用户布局<router-view></router-view></div>',
    children: [
      {
        path: '',
        component: '<div>用户列表</div>'
      },
      {
        path: ':id',
        component: (params) => `<div>用户详情: ${params.id}</div>`
      },
      {
        path: ':id/edit',
        component: (params) => `<div>编辑用户: ${params.id}</div>`
      }
    ]
  }
];
```

### 路由别名和重定向

```javascript
const routes = [
  {
    path: '/home',
    redirect: '/'
  },
  {
    path: '/user',
    alias: ['/users', '/member'],
    component: '<div>用户页面</div>'
  },
  {
    path: '/old-path',
    redirect: to => {
      // 动态重定向
      return { path: '/new-path', query: to.query };
    }
  }
];
```

## 路由模式

### Hash 模式（默认）

```javascript
const router = createRouter({
  mode: RouterMode.HASH,
  routes: routes
});

// URL 示例: http://example.com/#/user/123
```

### History 模式

```javascript
const router = createRouter({
  mode: RouterMode.HISTORY,
  base: '/app/',
  routes: routes
});

// URL 示例: http://example.com/app/user/123
```

### Abstract 模式

```javascript
const router = createRouter({
  mode: RouterMode.ABSTRACT,
  routes: routes
});

// 用于非浏览器环境，如 Node.js
```

## API 参考

### 路由器实例方法

#### `router.push(location, onComplete?, onAbort?)`

编程式导航到新路由。

```javascript
// 字符串路径
router.push('/user/123');

// 对象形式
router.push({ path: '/user/123' });
router.push({ name: 'user', params: { id: '123' } });
router.push({ path: '/search', query: { q: 'vue' } });

// 带回调
router.push('/user/123', 
  route => console.log('导航成功', route),
  error => console.log('导航失败', error)
);

// 返回 Promise
router.push('/user/123')
  .then(route => console.log('导航成功'))
  .catch(error => console.log('导航失败'));
```

#### `router.replace(location, onComplete?, onAbort?)`

替换当前路由，不会在历史记录中留下记录。

```javascript
router.replace('/login');
router.replace({ name: 'login' });
```

#### `router.go(n)`

在历史记录中前进或后退。

```javascript
router.go(1);  // 前进一步
router.go(-1); // 后退一步
router.go(3);  // 前进三步
```

#### `router.back()` / `router.forward()`

```javascript
router.back();    // 等同于 router.go(-1)
router.forward(); // 等同于 router.go(1)
```

#### `router.resolve(to, current?, append?)`

解析目标位置。

```javascript
const resolved = router.resolve('/user/123');
console.log(resolved.route);     // 路由对象
console.log(resolved.href);      // 完整URL
console.log(resolved.location);  // 标准化的位置对象
```

### 动态路由管理

#### `router.addRoute(parentOrRoute, route?)`

动态添加路由。

```javascript
// 添加顶级路由
router.addRoute({
  path: '/new-page',
  component: '<div>新页面</div>'
});

// 添加子路由
router.addRoute('parent-route', {
  path: 'child',
  component: '<div>子页面</div>'
});
```

#### `router.addRoutes(routes)`

批量添加路由。

```javascript
router.addRoutes([
  { path: '/page1', component: '<div>页面1</div>' },
  { path: '/page2', component: '<div>页面2</div>' }
]);
```

#### `router.getRoutes()`

获取所有路由记录。

```javascript
const allRoutes = router.getRoutes();
console.log(allRoutes);
```

### 生命周期钩子

#### `router.onReady(callback, errorCallback?)`

路由器初始化完成后的回调。

```javascript
router.onReady(() => {
  console.log('路由器已就绪');
}, error => {
  console.error('路由器初始化失败', error);
});
```

#### `router.onError(callback)`

全局错误处理。

```javascript
router.onError(error => {
  console.error('路由错误:', error);
});
```

### 组件加载

#### `router.loadComponent(path, maxRetries?)`

异步加载组件，支持缓存和重试。

```javascript
const component = await router.loadComponent('/components/UserDetail.html');
console.log(component); // HTML 内容
```

## 导航守卫

### 全局前置守卫

```javascript
const unregister = router.beforeEach((to, from, next) => {
  console.log('即将导航到:', to.path);
  
  // 检查认证
  if (to.meta.requiresAuth && !isAuthenticated()) {
    next('/login');
  } else {
    next();
  }
});

// 取消注册
unregister();
```

### 全局解析守卫

```javascript
router.beforeResolve((to, from, next) => {
  console.log('导航被确认');
  next();
});
```

### 全局后置钩子

```javascript
router.afterEach((to, from) => {
  console.log('导航完成:', to.path);
  
  // 更新页面标题
  if (to.meta.title) {
    document.title = to.meta.title;
  }
  
  // 发送页面浏览统计
  analytics.track('page_view', { path: to.path });
});
```

### 路由独享守卫

```javascript
const routes = [
  {
    path: '/admin',
    component: '<div>管理面板</div>',
    beforeEnter: (to, from, next) => {
      if (hasAdminPermission()) {
        next();
      } else {
        next('/unauthorized');
      }
    }
  }
];
```

### 导航守卫的完整执行流程

1. 导航被触发
2. 调用全局的 `beforeEach` 守卫
3. 在重用的组件里调用 `beforeRouteUpdate` 守卫
4. 在路由配置里调用 `beforeEnter`
5. 解析异步路由组件
6. 在被激活的组件里调用 `beforeRouteEnter`
7. 调用全局的 `beforeResolve` 守卫
8. 导航被确认
9. 调用全局的 `afterEach` 钩子
10. 触发 DOM 更新

## 自定义元素

### `<router-link>`

用于创建导航链接。

```html
<!-- 基本用法 -->
<router-link to="/user/123">用户详情</router-link>

<!-- 命名路由 -->
<router-link :to="{ name: 'user', params: { id: 123 }}">用户详情</router-link>

<!-- 带查询参数 -->
<router-link to="/search?q=vue">搜索</router-link>

<!-- 替换历史记录 -->
<router-link to="/login" replace>登录</router-link>

<!-- 自定义标签 -->
<router-link to="/about" tag="button">关于我们</router-link>

<!-- 自定义激活类名 -->
<router-link 
  to="/user" 
  active-class="active"
  exact-active-class="exact-active">
  用户中心
</router-link>
```

#### 属性说明

- `to`: 目标路由的链接（必需）
- `replace`: 是否替换当前历史记录
- `tag`: 渲染的HTML标签，默认为 `a`
- `active-class`: 激活时的CSS类名
- `exact-active-class`: 精确匹配时的CSS类名

### `<router-view>`

用于渲染匹配的组件。

```html
<!-- 默认视图 -->
<router-view></router-view>

<!-- 命名视图 -->
<router-view name="sidebar"></router-view>
<router-view name="main"></router-view>
```

#### 命名视图示例

```javascript
const routes = [
  {
    path: '/dashboard',
    components: {
      default: '<div>主要内容</div>',
      sidebar: '<div>侧边栏</div>',
      header: '<div>头部</div>'
    }
  }
];
```

```html
<div class="layout">
  <router-view name="header"></router-view>
  <div class="content">
    <router-view name="sidebar"></router-view>
    <router-view></router-view> <!-- 默认视图 -->
  </div>
</div>
```

## 错误处理

### 导航失败类型

```javascript
import { NavigationFailureType, isNavigationFailure } from './router.js';

router.push('/user/123').catch(error => {
  if (isNavigationFailure(error, NavigationFailureType.ABORTED)) {
    console.log('导航被中止');
  } else if (isNavigationFailure(error, NavigationFailureType.CANCELLED)) {
    console.log('导航被取消');
  } else if (isNavigationFailure(error, NavigationFailureType.DUPLICATED)) {
    console.log('重复导航');
  }
});
```

### 全局错误处理

```javascript
router.onError(error => {
  console.error('路由错误:', error);
  
  // 发送错误报告
  if (error.name === 'NavigationAborted') {
    analytics.track('navigation_aborted', {
      from: error.from?.path,
      to: error.to?.path
    });
  }
});
```

### 组件加载错误处理

```javascript
try {
  const component = await router.loadComponent('/path/to/component.html');
} catch (error) {
  console.error('组件加载失败:', error);
  // 显示错误页面或降级方案
}
```

## 性能优化

### 路由缓存

路由器内置了LRU缓存机制，自动缓存组件内容。

```javascript
const router = createRouter({
  routes: routes,
  cacheSize: 100  // 缓存大小，默认50
});
```

### 懒加载组件

```javascript
const routes = [
  {
    path: '/heavy-component',
    component: async () => {
      // 动态导入组件
      const response = await fetch('/components/HeavyComponent.html');
      return await response.text();
    }
  }
];
```

### 进度条

路由器自动显示加载进度条，可以自定义样式：

```css
#router-progress {
  background: linear-gradient(90deg, #ff6b6b, #feca57) !important;
  height: 4px !important;
}
```

## 高级功能

### 滚动行为

```javascript
const router = createRouter({
  mode: RouterMode.HISTORY,
  routes: routes,
  scrollBehavior(to, from, savedPosition) {
    if (savedPosition) {
      // 浏览器前进/后退时恢复滚动位置
      return savedPosition;
    } else if (to.hash) {
      // 滚动到锚点
      return { selector: to.hash };
    } else {
      // 滚动到顶部
      return { x: 0, y: 0 };
    }
  }
});
```

### 导航取消

```javascript
let navigationPromise = router.push('/slow-page');

// 在某些条件下取消导航
setTimeout(() => {
  navigationPromise = router.push('/other-page');
}, 1000);
```

### 元信息处理

```javascript
const routes = [
  {
    path: '/user/:id',
    component: userComponent,
    meta: {
      title: '用户详情',
      description: '查看用户信息',
      keywords: 'user, profile',
      requiresAuth: true,
      permissions: ['user:read']
    }
  }
];

router.afterEach(to => {
  // 更新页面元信息
  if (to.meta.title) {
    document.title = to.meta.title;
  }
  
  if (to.meta.description) {
    updateMetaTag('description', to.meta.description);
  }
});

function updateMetaTag(name, content) {
  let meta = document.querySelector(`meta[name="${name}"]`);
  if (!meta) {
    meta = document.createElement('meta');
    meta.name = name;
    document.head.appendChild(meta);
  }
  meta.content = content;
}
```

### 路由过渡动画

```css
.route-enter {
  opacity: 0;
  transform: translateX(30px);
}

.route-enter-active {
  transition: all 0.3s ease;
}

.route-leave-active {
  transition: all 0.3s ease;
  position: absolute;
}

.route-leave-to {
  opacity: 0;
  transform: translateX(-30px);
}
```

```javascript
// 在组件中添加过渡效果
const routerView = document.querySelector('router-view');
routerView.style.position = 'relative';
routerView.style.overflow = 'hidden';
```

## 最佳实践

### 1. 路由结构设计

```javascript
// 推荐：按模块组织路由
const userRoutes = [
  { path: '/user', component: UserList },
  { path: '/user/:id', component: UserDetail },
  { path: '/user/:id/edit', component: UserEdit }
];

const adminRoutes = [
  { path: '/admin', component: AdminDashboard },
  { path: '/admin/users', component: AdminUsers },
  { path: '/admin/settings', component: AdminSettings }
];

const routes = [
  ...userRoutes,
  ...adminRoutes,
  { path: '*', component: NotFound } // 404页面
];
```

### 2. 权限控制

```javascript
// 统一的权限检查
function checkPermissions(permissions) {
  return permissions.every(permission => 
    currentUser.permissions.includes(permission)
  );
}

router.beforeEach((to, from, next) => {
  const { requiresAuth, permissions } = to.meta;
  
  if (requiresAuth && !isAuthenticated()) {
    next('/login');
  } else if (permissions && !checkPermissions(permissions)) {
    next('/unauthorized');
  } else {
    next();
  }
});
```

### 3. 错误边界

```javascript
// 全局错误处理
router.onError(error => {
  console.error('路由错误:', error);
  
  // 根据错误类型处理
  if (error.message.includes('Network Error')) {
    showNotification('网络连接失败，请检查网络设置');
  } else if (error.message.includes('404')) {
    router.push('/404');
  } else {
    router.push('/error');
  }
});
```

### 4. 性能监控

```javascript
router.beforeEach((to, from, next) => {
  // 记录导航开始时间
  performance.mark('navigation-start');
  next();
});

router.afterEach((to, from) => {
  // 记录导航结束时间
  performance.mark('navigation-end');
  performance.measure('navigation-duration', 'navigation-start', 'navigation-end');
  
  const measures = performance.getEntriesByName('navigation-duration');
  const duration = measures[measures.length - 1].duration;
  
  console.log(`导航到 ${to.path} 耗时: ${duration.toFixed(2)}ms`);
});
```

### 5. 内存管理

```javascript
// 在组件销毁时清理资源
class MyComponent {
  constructor() {
    this.unregisterGuard = router.beforeEach(this.handleNavigation.bind(this));
  }
  
  destroy() {
    // 取消注册守卫
    this.unregisterGuard();
    
    // 清理其他资源
    this.cleanup();
  }
}

// 在应用关闭时销毁路由器
window.addEventListener('beforeunload', () => {
  router.destroy();
});
```

### 6. 开发调试

```javascript
// 开发环境下启用详细日志
if (process.env.NODE_ENV === 'development') {
  router.beforeEach((to, from, next) => {
    console.group(`🚀 导航: ${from.path} → ${to.path}`);
    console.log('目标路由:', to);
    console.log('来源路由:', from);
    console.groupEnd();
    next();
  });
  
  router.afterEach((to, from) => {
    console.log(`✅ 导航完成: ${to.path}`);
  });
}
```

### 7. 工具函数封装

```javascript
// 创建常用的导航方法
export const navigationUtils = {
  goHome: () => router.push('/'),
  goBack: () => router.back(),
  goToUser: (id) => router.push(`/user/${id}`),
  goToLogin: (redirect) => router.push({
    path: '/login',
    query: { redirect }
  }),
  
  // 带确认的导航
  confirmNavigation: (path, message = '确定要离开当前页面吗？') => {
    if (confirm(message)) {
      router.push(path);
    }
  }
};
```

这个路由器提供了完整的单页应用路由解决方案，具有高性能、高可靠性和丰富的功能特性。通过合理使用这些API和最佳实践，可以构建出用户体验优秀的Web应用。