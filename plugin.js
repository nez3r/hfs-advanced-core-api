exports.version = 1.01
exports.apiRequired = 10.3
exports.repo = "nez3r/hfs-advanced-core-api"
exports.description = "Расширенный API: Безопасный просмотр файлов, авторизация через формы и парсинг контента с учетом VFS прав"

exports.config = {
    apiPrefix: {
        type: 'string',
        label: 'API URL Префикс',
        defaultValue: '/api/v1',
        helperText: 'Базовый URL для всех эндпоинтов API.'
    }
}

exports.init = async api => {
    // Вспомогательная функция для проверки прав на конкретный узел VFS
    async function checkAccess(ctx, node, permissionType = 'read') {
        const user = ctx.session?.user || 'guest';
        if (api.canAccess) {
            return await api.canAccess(node, user, permissionType);
        }
        const perms = node.permissions?.[permissionType] || [];
        return perms.length === 0 || perms.includes(user);
    }

    // Вспомогательная функция поиска узла VFS по его URI путю
    async function findVfsNodeByPath(vfs, searchPath) {
        if (!vfs || !vfs.children) return null;
        const parts = searchPath.split('/').filter(Boolean);
        
        let currentNode = vfs;
        for (const part of parts) {
            const decodedPart = decodeURIComponent(part);
            if (currentNode.children && currentNode.children[decodedPart]) {
                currentNode = currentNode.children[decodedPart];
            } else {
                return null; // Путь не найден в дереве VFS
            }
        }
        return currentNode;
    }

    exports.middleware = async (ctx, next) => {
        const prefix = api.getConfig('apiPrefix') || '/api/v1';
        
        // Проверяем, относится ли запрос к нашему API
        if (!ctx.path.startsWith(prefix)) {
            return next();
        }

        const relativePath = ctx.path.substring(prefix.length);
        const user = ctx.session?.user || 'guest';

        try {
            // ==========================================================
            // 1. ЭНДПОИНТ: АВТОРИЗАЦИЯ (Вход в аккаунт через HTML)
            // ==========================================================
            if (relativePath === '/auth/login' && ctx.method === 'POST') {
                const { username, password } = ctx.request?.body || ctx.query || {};
                
                if (!username || !password) {
                    ctx.status = 400;
                    ctx.body = { status: "error", message: "Укажите username и password" };
                    return ctx.stop?.() || true;
                }

                // Используем внутренний метод HFS для проверки учетных данных
                // Примечание: В зависимости от точной минорной версии HFS v3/v4 метод может называться верификатором аккаунтов.
                const accounts = api.getConfig('accounts') || {};
                const account = accounts[username];

                if (account && account.password === password) {
                    // Создаем или обновляем сессию HFS
                    if (!ctx.session) ctx.session = {};
                    ctx.session.user = username;
                    
                    ctx.status = 200;
                    ctx.body = { 
                        status: "success", 
                        message: `Успешный вход. Добро пожаловать, ${username}!`,
                        user: username 
                    };
                } else {
                    ctx.status = 401;
                    ctx.body = { status: "error", message: "Неверное имя пользователя или пароль" };
                }
                return ctx.stop?.() || true;
            }

            // Статус текущей сессии (Кто я?)
            if (relativePath === '/auth/me') {
                ctx.body = { status: "success", user: user, isGuest: user === 'guest' };
                return ctx.stop?.() || true;
            }

            // Выход из аккаунта
            if (relativePath === '/auth/logout') {
                if (ctx.session) ctx.session.user = 'guest';
                ctx.body = { status: "success", message: "Вы успешно вышли" };
                return ctx.stop?.() || true;
            }

            // ==========================================================
            // ДЛЯ ВСЕХ ОСТАЛЬНЫХ МЕТОДОВ ТРЕБУЕТСЯ ДОСТУП К ДЕРЕВУ VFS
            // ==========================================================
            const vfs = typeof api.getVfs === 'function' ? await api.getVfs() : null;
            if (!vfs) {
                ctx.status = 500;
                ctx.body = { status: "error", message: "Ошибка инициализации подсистемы VFS" };
                return ctx.stop?.() || true;
            }

            // ==========================================================
            // 2. ЭНДПОИНТ: ПРОСМОТР СОДЕРЖИМОГО ДИРЕКТОРИИ
            // ==========================================================
            if (relativePath === '/browse') {
                const targetPath = ctx.query.path || '/'; // Передаем ?path=/iso или ?path=/D:/
                const targetNode = await findVfsNodeByPath(vfs, targetPath);

                if (!targetNode) {
                    ctx.status = 404;
                    ctx.body = { status: "error", message: "Указанный каталог не найден в VFS" };
                    return ctx.stop?.() || true;
                }

                // Проверяем права на чтение этой директории
                const hasAccess = await checkAccess(ctx, targetNode, 'read');
                if (!hasAccess) {
                    ctx.status = 403;
                    ctx.body = { status: "error", message: "Доступ к этому каталогу ограничен для вашего аккаунта" };
                    return ctx.stop?.() || true;
                }

                // Собираем содержимое
                const items = [];
                if (targetNode.children) {
                    for (const [name, childNode] of Object.entries(targetNode.children)) {
                        // Фильтруем элементы внутри папки по правам
                        if (await checkAccess(ctx, childNode, 'read')) {
                            items.push({
                                name: name,
                                type: childNode.type || (childNode.children ? 'folder' : 'file'),
                                size: childNode.size || 0,
                                modified: childNode.mtime || null
                            });
                        }
                    }
                }

                ctx.body = {
                    status: "success",
                    currentPath: targetPath,
                    items: items
                };
                return ctx.stop?.() || true;
            }

            // ==========================================================
            // 3. ЭНДПОИНТ: ПАРСИНГ ФАЙЛА (Чтение метаданных/контента)
            // ==========================================================
            if (relativePath === '/file-info') {
                const filePath = ctx.query.path; // ?path=/iso/notes.txt
                if (!filePath) {
                    ctx.status = 400;
                    ctx.body = { status: "error", message: "Параметр path обязателен" };
                    return ctx.stop?.() || true;
                }

                const fileNode = await findVfsNodeByPath(vfs, filePath);
                if (!fileNode || fileNode.children) {
                    ctx.status = 404;
                    ctx.body = { status: "error", message: "Файл не найден или является папкой" };
                    return ctx.stop?.() || true;
                }

                // Проверяем права
                const hasAccess = await checkAccess(ctx, fileNode, 'read');
                if (!hasAccess) {
                    ctx.status = 403;
                    ctx.body = { status: "error", message: "У вас нет прав на просмотр этого файла" };
                    return ctx.stop?.() || true;
                }

                // Базовая информация о файле
                const fileInfo = {
                    name: decodeURIComponent(filePath.split('/').pop()),
                    size: fileNode.size || 0,
                    mime: fileNode.mime || 'application/octet-stream',
                    extension: filePath.split('.').pop().toLowerCase()
                };

                // Умный парсинг текстовых файлов (например, .txt, .log, .json, .ini)
                const textExtensions = ['txt', 'log', 'json', 'ini', 'inf', 'bat'];
                if (textExtensions.includes(fileInfo.extension) && fileInfo.size < 1024 * 1024) { // Ограничение в 1МБ для безопасности
                    try {
                        const fs = api.require('fs').promises;
                        // Если у ноды есть реальный физический путь на диске
                        if (fileNode.source) {
                            const content = await fs.readFile(fileNode.source, 'utf8');
                            fileInfo.isText = true;
                            fileInfo.content = content;
                        }
                    } catch (fsErr) {
                        fileInfo.contentError = "Не удалось прочесть содержимое с диска";
                    }
                }

                ctx.body = {
                    status: "success",
                    file: fileInfo
                };
                return ctx.stop?.() || true;
            }

        } catch (globalErr) {
            ctx.status = 500;
            ctx.body = { status: "error", message: "Критическая ошибка API", details: globalErr.message };
            return ctx.stop?.() || true;
        }

        return next();
    };
};