exports.version = 1.25
exports.apiRequired = 10.3
exports.repo = "nez3rall/hfs-advanced-core-api"
exports.description = "Расширенный API: Безопасный просмотр файлов, авторизация и парсинг с учетом VFS прав"

exports.config = {
    apiPrefix: {
        type: 'string',
        label: 'API URL Префикс',
        defaultValue: '/api/v1',
        helperText: 'Базовый URL для всех эндпоинтов API.'
    }
}

exports.init = async api => {
    
    // Вспомогательная функция проверки прав
    async function checkAccess(ctx, node, permissionType = 'read') {
        const user = ctx.session?.user || 'guest';
        if (api.canAccess) {
            return await api.canAccess(node, user, permissionType);
        }
        const perms = node.permissions?.[permissionType] || [];
        return perms.length === 0 || perms.includes(user);
    }

    // Вспомогательная функция поиска ноды VFS
    async function findVfsNodeByPath(vfs, searchPath) {
        if (!vfs || !vfs.children) return null;
        if (searchPath === '/' || searchPath === '') return vfs; // Корень
        
        const parts = searchPath.split('/').filter(Boolean);
        let currentNode = vfs;
        
        for (const part of parts) {
            const decodedPart = decodeURIComponent(part);
            if (currentNode.children && currentNode.children[decodedPart]) {
                currentNode = currentNode.children[decodedPart];
            } else {
                return null;
            }
        }
        return currentNode;
    }

    exports.middleware = async (ctx, next) => {
        const prefix = api.getConfig('apiPrefix') || '/api/v1';
        
        if (!ctx.path.startsWith(prefix)) return next();

        const relativePath = ctx.path.substring(prefix.length);
        const user = ctx.session?.user || 'guest';

        try {
            // 1. КОРЕНЬ API (Исправление ошибки 500)
            if (relativePath === '' || relativePath === '/') {
                ctx.status = 200;
                ctx.type = 'application/json';
                ctx.body = {
                    status: "success",
                    message: "HFS Advanced Core API работает стабильно",
                    currentUser: user,
                    endpoints: {
                        me: `${prefix}/auth/me`,
                        login: `${prefix}/auth/login (POST: username, password)`,
                        logout: `${prefix}/auth/logout`,
                        browse: `${prefix}/browse?path=/`,
                        fileInfo: `${prefix}/file-info?path=/file.txt`
                    }
                };
                return ctx.stop?.() || true;
            }

            // 2. АВТОРИЗАЦИЯ
            if (relativePath === '/auth/login' && ctx.method === 'POST') {
                // Если используем встроенный парсер body Koa, либо пытаемся достать из сырого запроса
                let body = {};
                try {
                    // Костыль, если koa-body не подключен глобально
                    if (ctx.request.body) body = ctx.request.body;
                    else {
                        const rawBody = await new Promise(resolve => {
                            let data = '';
                            ctx.req.on('data', chunk => data += chunk);
                            ctx.req.on('end', () => resolve(data));
                        });
                        body = rawBody ? JSON.parse(rawBody) : {};
                    }
                } catch(e) {}

                const username = body.username || ctx.query.username;
                const password = body.password || ctx.query.password;

                const accounts = api.getConfig('accounts') || {};
                const account = accounts[username];

                if (account && account.password === password) {
                    if (!ctx.session) ctx.session = {};
                    ctx.session.user = username;
                    ctx.body = { status: "success", message: `Добро пожаловать, ${username}!`, user: username };
                } else {
                    ctx.status = 401;
                    ctx.body = { status: "error", message: "Неверные данные" };
                }
                return ctx.stop?.() || true;
            }

            if (relativePath === '/auth/me') {
                ctx.body = { status: "success", user: user, isGuest: user === 'guest' };
                return ctx.stop?.() || true;
            }

            if (relativePath === '/auth/logout') {
                if (ctx.session) ctx.session.user = 'guest';
                ctx.body = { status: "success", message: "Вы вышли из аккаунта" };
                return ctx.stop?.() || true;
            }

            // 3. ПОЛУЧЕНИЕ VFS (Для Browse и FileInfo)
            const vfs = typeof api.getVfs === 'function' ? await api.getVfs() : null;
            if (!vfs) {
                ctx.status = 500;
                ctx.body = { status: "error", message: "VFS не инициализирована сервером" };
                return ctx.stop?.() || true;
            }

            // 4. ПРОСМОТР КАТАЛОГОВ
            if (relativePath === '/browse') {
                const targetPath = ctx.query.path || '/';
                const targetNode = await findVfsNodeByPath(vfs, targetPath);

                if (!targetNode) {
                    ctx.status = 404;
                    ctx.body = { status: "error", message: "Папка не найдена" };
                    return ctx.stop?.() || true;
                }

                // Корневая папка (/) всегда доступна для чтения структуры
                if (targetPath !== '/' && !(await checkAccess(ctx, targetNode, 'read'))) {
                    ctx.status = 403;
                    ctx.body = { status: "error", message: "Доступ запрещен" };
                    return ctx.stop?.() || true;
                }

                const items = [];
                if (targetNode.children) {
                    for (const [name, childNode] of Object.entries(targetNode.children)) {
                        if (await checkAccess(ctx, childNode, 'read')) {
                            items.push({
                                name: name,
                                type: childNode.type || (childNode.children ? 'folder' : 'file'),
                                size: childNode.size || 0,
                                isDisk: name.includes(':')
                            });
                        }
                    }
                }

                ctx.body = { status: "success", currentPath: targetPath, items: items };
                return ctx.stop?.() || true;
            }

            // 5. ИНФОРМАЦИЯ О ФАЙЛЕ
            if (relativePath === '/file-info') {
                const filePath = ctx.query.path;
                const fileNode = await findVfsNodeByPath(vfs, filePath);
                
                if (!fileNode || fileNode.children) {
                    ctx.status = 404;
                    ctx.body = { status: "error", message: "Файл не найден" };
                    return ctx.stop?.() || true;
                }

                if (!(await checkAccess(ctx, fileNode, 'read'))) {
                    ctx.status = 403;
                    ctx.body = { status: "error", message: "Доступ к файлу запрещен" };
                    return ctx.stop?.() || true;
                }

                const ext = filePath.split('.').pop().toLowerCase();
                const isText = ['txt', 'log', 'json', 'ini', 'md'].includes(ext);
                let content = null;

                // Если это мелкий текст, пробуем прочесть (защита 1MB)
                if (isText && fileNode.source && (fileNode.size || 0) < 1024 * 1024) {
                    try {
                        content = await api.require('fs').promises.readFile(fileNode.source, 'utf8');
                    } catch(e) {}
                }

                ctx.body = {
                    status: "success",
                    file: {
                        name: decodeURIComponent(filePath.split('/').pop()),
                        size: fileNode.size || 0,
                        type: ext,
                        isText: !!content,
                        content: content
                    }
                };
                return ctx.stop?.() || true;
            }

        } catch (err) {
            ctx.status = 500;
            ctx.body = { status: "error", message: "Ошибка API", details: err.message };
            return ctx.stop?.() || true;
        }

        return next();
    };
};