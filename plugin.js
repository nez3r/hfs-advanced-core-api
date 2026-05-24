exports.version = 1.30
exports.apiRequired = 10.3
exports.repo = "nez3rall/hfs-advanced-core-api"
exports.description = "Расширенный API (Исправлены баги авторизации и доступа к VFS)"

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
        if (typeof api.canAccess === 'function') {
            return await api.canAccess(node, user, permissionType);
        }
        const perms = node.permissions?.[permissionType] || [];
        return perms.length === 0 || perms.includes(user);
    }

    // Умный поиск папки (учитывает разные структуры VFS)
    async function findVfsNodeByPath(vfs, searchPath) {
        if (!vfs) return null;
        if (searchPath === '/' || searchPath === '') return vfs;
        
        const parts = searchPath.split('/').filter(Boolean);
        let currentNode = vfs;
        
        for (const part of parts) {
            const decodedPart = decodeURIComponent(part);
            // В одних версиях HFS вложенные папки лежат в .children, в других - прямо в объекте
            const children = currentNode.children || currentNode; 
            
            if (children && children[decodedPart]) {
                currentNode = children[decodedPart];
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
            // 1. КОРЕНЬ API
            if (relativePath === '' || relativePath === '/') {
                ctx.status = 200;
                ctx.body = { status: "success", message: "API работает (v1.30)" };
                return ctx.stop?.() || true;
            }

            // 2. ИСПРАВЛЕННАЯ АВТОРИЗАЦИЯ
            if (relativePath === '/auth/login' && ctx.method === 'POST') {
                let body = {};
                try {
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

                const accounts = api.getConfig('accounts') || [];
                let account = null;
                
                // Исправление: Ищем аккаунт в массиве (HFS 3/4)
                if (Array.isArray(accounts)) {
                    account = accounts.find(a => (a.name === username || a.username === username));
                } else {
                    account = accounts[username];
                }

                if (account && account.password === password) {
                    if (!ctx.session) ctx.session = {};
                    ctx.session.user = username;
                    ctx.body = { status: "success", message: `Добро пожаловать, ${username}!`, user: username };
                } else {
                    ctx.status = 401;
                    ctx.body = { status: "error", message: "Неверный логин или пароль" };
                }
                return ctx.stop?.() || true;
            }

            if (relativePath === '/auth/me') {
                ctx.body = { status: "success", user: user, isGuest: user === 'guest' };
                return ctx.stop?.() || true;
            }

            if (relativePath === '/auth/logout') {
                if (ctx.session) ctx.session.user = 'guest';
                ctx.body = { status: "success", message: "Успешный выход" };
                return ctx.stop?.() || true;
            }

            // 3. ИСПРАВЛЕННОЕ ПОЛУЧЕНИЕ VFS
            // Перебираем все возможные варианты хранения дерева в HFS
            let vfs = null;
            if (typeof api.getVfs === 'function') vfs = await api.getVfs();
            if (!vfs && api.vfs) vfs = api.vfs;
            if (!vfs) vfs = api.getConfig('vfs');

            if (!vfs) {
                ctx.status = 500;
                ctx.body = { 
                    status: "error", 
                    message: "Критическая ошибка: Дерево VFS не найдено",
                    debug_methods: Object.keys(api) // Отправляем доступные методы для отладки
                };
                return ctx.stop?.() || true;
            }

            // 4. ПРОСМОТР КАТАЛОГОВ
            if (relativePath === '/browse') {
                const targetPath = ctx.query.path || '/';
                const targetNode = await findVfsNodeByPath(vfs, targetPath);

                if (!targetNode) {
                    ctx.status = 404;
                    ctx.body = { status: "error", message: "Папка не найдена в VFS" };
                    return ctx.stop?.() || true;
                }

                if (targetPath !== '/' && !(await checkAccess(ctx, targetNode, 'read'))) {
                    ctx.status = 403;
                    ctx.body = { status: "error", message: "Доступ запрещен" };
                    return ctx.stop?.() || true;
                }

                const items = [];
                // Берем дочерние элементы с защитой от разных структур данных
                const children = targetNode.children || targetNode;
                
                for (const [name, childNode] of Object.entries(children)) {
                    // Защита: пропускаем системные свойства конфигурации
                    if (['source', 'permissions', 'type', 'name', 'mime', 'size', 'mtime'].includes(name)) continue;
                    if (typeof childNode !== 'object' || childNode === null) continue;

                    if (await checkAccess(ctx, childNode, 'read')) {
                        items.push({
                            name: name,
                            type: childNode.type || (childNode.children ? 'folder' : 'file'),
                            size: childNode.size || 0,
                            isDisk: name.includes(':')
                        });
                    }
                }

                ctx.body = { status: "success", currentPath: targetPath, items: items };
                return ctx.stop?.() || true;
            }

            // 5. ИНФОРМАЦИЯ О ФАЙЛЕ (без изменений)
            if (relativePath === '/file-info') {
                const filePath = ctx.query.path;
                const fileNode = await findVfsNodeByPath(vfs, filePath);
                
                if (!fileNode || fileNode.children || typeof fileNode !== 'object') {
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