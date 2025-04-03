const { Plugin, ItemView, setIcon, Platform, Modal } = require('obsidian');

const FOOTNOTES_VIEW_TYPE = 'footnotes-panel';

class FootnotesView extends ItemView {
    constructor(leaf) {
        super(leaf);
        this.footnotes = [];
        this.footnoteElements = new Map();
        this.lastContent = ''; // 用于跟踪内容变化
    }

    getViewType() {
        return FOOTNOTES_VIEW_TYPE;
    }

    getDisplayText() {
        return '脚注面板';
    }

    // 添加 getIcon 方法
    getIcon() {
        return 'message-square';
    }

    async onOpen() {
        const container = this.containerEl.children[1];
        container.empty();
        container.createEl('h4', { text: '评论' });

        const footnotesContainer = container.createEl('div', {
            cls: 'footnotes-container'
        });

        // 立即更新脚注
        await this.updateFootnotes();

        // 监听文件切换
        this.registerEvent(
            this.app.workspace.on('file-open', () => {
                this.updateFootnotes();
            })
        );

        // 监听编辑器变化
        this.registerEvent(
            this.app.workspace.on('editor-change', this.debounce(() => {
                console.log('编辑器内容变化，更新脚注面板');
                this.updateFootnotes();
            }, 100))
        );

        // 添加额外的文件内容变化监听
        this.registerEvent(
            this.app.vault.on('modify', (file) => {
                const activeFile = this.app.workspace.getActiveFile();
                if (activeFile && file && file.path === activeFile.path) {
                    console.log('文件内容被修改，更新脚注面板');
                    this.updateFootnotes();
                }
            })
        );

        // 监听预览视图的点击事件
        this.registerDomEvent(document, 'click', (event) => {
            // 检查点击的元素是否是脚注链接
            let target = event.target;
            while (target && target.tagName !== 'A' && target !== document.body) {
                target = target.parentElement;
            }

            if (target && target.tagName === 'A' && 
                (target.classList.contains('footnote-link') || target.closest('sup.footnote-ref'))) {
                
                event.preventDefault();
                event.stopPropagation();

                // 获取脚注ID
                const footnoteId = target.dataset.footref || 
                                 target.getAttribute('href')?.replace('#fn-', '') ||
                                 target.closest('sup.footnote-ref')?.dataset.footnoteId;

                if (footnoteId) {
                    this.highlightFootnote(footnoteId);
                }
            }
        });
    }

    setupFootnoteClickHandlers() {
        // 获取所有脚注链接元素
        const footnoteLinks = document.querySelectorAll('a.footnote-link');
        console.log('Found footnote links:', footnoteLinks.length); // 调试用

        footnoteLinks.forEach(link => {
            // 移除旧的事件监听器
            const oldHandler = link._footnoteClickHandler;
            if (oldHandler) {
                link.removeEventListener('click', oldHandler);
            }

            // 创建新的事件处理函数
            const clickHandler = async (event) => {
                console.log('Footnote link clicked:', link); // 调试用
                event.preventDefault();
                event.stopPropagation();

                // 获取脚注ID
                const footnoteId = link.getAttribute('data-footref') || 
                                 link.getAttribute('href')?.replace('#fn-', '');

                console.log('Footnote ID:', footnoteId); // 调试用

                if (!footnoteId) return;

                try {
                    // 确保面板可见
                    const leaf = this.app.workspace.getLeavesOfType(FOOTNOTES_VIEW_TYPE)[0];
                    if (!leaf) {
                        await this.app.workspace.getRightLeaf(false).setViewState({
                            type: FOOTNOTES_VIEW_TYPE,
                            active: true,
                        });
                    }
                    await this.app.workspace.revealLeaf(
                        this.app.workspace.getLeavesOfType(FOOTNOTES_VIEW_TYPE)[0]
                    );

                    // 高亮并滚动到对应的脚注
                    const footnoteEl = this.footnoteElements.get(footnoteId);
                    if (footnoteEl) {
                        // 移除所有高亮
                        this.footnoteElements.forEach(el => {
                            el.removeClass('footnote-highlight-panel');
                            el.removeClass('footnote-highlight-panel-flash');
                        });

                        // 添加高亮效果
                        footnoteEl.addClass('footnote-highlight-panel');
                        footnoteEl.addClass('footnote-highlight-panel-flash');

                        // 滚动到对应位置
                        const container = this.containerEl.querySelector('.footnotes-container');
                        if (container) {
                            const containerRect = container.getBoundingClientRect();
                            const elementRect = footnoteEl.getBoundingClientRect();
                            const scrollTop = container.scrollTop + 
                                (elementRect.top - containerRect.top) - 
                                (containerRect.height - elementRect.height) / 2;

                            container.scrollTo({
                                top: scrollTop,
                                behavior: 'smooth'
                            });
                        }

                        // 移除闪烁效果
                        setTimeout(() => {
                            footnoteEl.removeClass('footnote-highlight-panel-flash');
                        }, 2000);
                    }
                } catch (error) {
                    console.error('处理脚注点击时出错:', error);
                }
            };

            // 保存事件处理函数引用
            link._footnoteClickHandler = clickHandler;

            // 添加点击事件监听器
            link.addEventListener('click', clickHandler);
            
            // 添加视觉反馈
            link.style.cursor = 'pointer';
            if (!link.title) {
                link.title = '点击查看脚注';
            }
        });
    }

    // 添加防抖函数
    debounce(func, wait) {
        let timeout;
        return (...args) => {
            clearTimeout(timeout);
            timeout = setTimeout(() => func.apply(this, args), wait);
        };
    }

    async updateFootnotes() {
        try {
            const activeFile = this.app.workspace.getActiveFile();
            if (!activeFile) {
                this.renderEmptyState();
                return;
            }

            let content = '';
            try {
                // 直接从文件读取内容
                content = await this.app.vault.read(activeFile);
            } catch (error) {
                console.error('读取文件内容时出错:', error);
                this.renderError();
                return;
            }

            if (!content) {
                console.log('文件内容为空');
                this.renderEmptyState();
                return;
            }

            // 解析新的脚注
            const newFootnotes = this.parseFootnotes(content);
            
            if (!Array.isArray(newFootnotes)) {
                console.error('解析脚注返回了无效的数据类型');
                this.renderError();
                return;
            }

            // 调试信息
            console.log('解析到的脚注数量:', newFootnotes.length);

            // 强制更新，不依赖于 checkIfUpdateNeeded
            this.footnotes = newFootnotes;
            await this.renderFootnotes(newFootnotes);

            // 更新内容缓存
            this.lastContent = content;

            // 设置点击处理器
            setTimeout(() => {
                this.setupFootnoteClickHandlers();
            }, 100);

        } catch (error) {
            console.error('更新脚注时出错:', error);
            this.renderError();
        }
    }

    // 检查是否需要更新视图
    checkIfUpdateNeeded(newFootnotes) {
        if (newFootnotes.length !== this.footnotes.length) {
            return true;
        }

        // 比较每个脚注的内容和位置
        return newFootnotes.some((newNote, index) => {
            const oldNote = this.footnotes[index];
            if (!oldNote) return true;

            // 检查ID是否改变
            if (newNote.id !== oldNote.id) return true;

            // 检查内容是否改变
            if (newNote.content !== oldNote.content) return true;

            // 检查位置是否改变
            if (newNote.position.line !== oldNote.position.line ||
                newNote.position.ch !== oldNote.position.ch) return true;

            // 检查引用数量和位置是否改变
            if (newNote.references.length !== oldNote.references.length) return true;

            // 检查每个引用的位置
            return newNote.references.some((ref, refIndex) => {
                const oldRef = oldNote.references[refIndex];
                if (!oldRef) return true;
                return ref.line !== oldRef.line || ref.ch !== oldRef.ch;
            });
        });
    }

    renderEmptyState() {
        const container = this.containerEl.children[1];
        const footnotesContainer = container.querySelector('.footnotes-container');
        if (!footnotesContainer) return;

        footnotesContainer.empty();
        footnotesContainer.createEl('div', {
            text: '请打开一个文档',
            cls: 'footnote-empty'
        });
    }

    renderError() {
        const container = this.containerEl.children[1];
        const footnotesContainer = container.querySelector('.footnotes-container');
        if (!footnotesContainer) return;

        footnotesContainer.empty();
        footnotesContainer.createEl('div', {
            text: '加载脚注时出错',
            cls: 'footnote-error'
        });
    }

    parseFootnotes(content) {
        if (typeof content !== 'string') {
            console.error('parseFootnotes 接收到无效的内容类型:', typeof content);
            return [];
        }

        try {
            const footnotes = new Map();
            const lines = content.split('\n');
            
            // 先找到所有脚注引用，记录第一次出现的位置
            lines.forEach((line, lineIndex) => {
                if (typeof line !== 'string') return;

                let match;
                // 匹配脚注引用 [^1] 格式
                const refRegex = /\[\^([^\]]+)\](?!:)/g;
                while ((match = refRegex.exec(line)) !== null) {
                    const id = match[1];
                    // 确保位置数据是数字类型
                    const refPosition = {
                        line: Number(lineIndex),
                        ch: Number(match.index)
                    };

                    if (!footnotes.has(id)) {
                        footnotes.set(id, {
                            id,
                            content: '',
                            position: null,
                            references: [],
                            firstRef: refPosition // 记录第一次引用的位置
                        });
                    }
                    footnotes.get(id).references.push(refPosition);
                }
            });

            // 再找到所有脚注定义
            let currentFootnote = null;
            let currentContent = [];

            lines.forEach((line, lineIndex) => {
                // 匹配脚注定义 [^1]: 格式
                const defMatch = line.match(/^\[\^([^\]]+)\]:\s*(.*)$/);
                
                if (defMatch) {
                    // 如果有正在处理的脚注，保存它
                    if (currentFootnote) {
                        const footnote = footnotes.get(currentFootnote.id);
                        if (footnote) {
                            footnote.content = currentContent.join('\n').trim();
                        }
                    }

                    const id = defMatch[1];
                    const firstLine = defMatch[2];
                    
                    currentFootnote = footnotes.get(id) || {
                        id,
                        content: '',
                        position: {
                            line: Number(lineIndex),
                            ch: Number(line.indexOf('[^'))
                        },
                        references: [],
                        firstRef: null
                    };
                    
                    currentContent = [firstLine];
                    currentFootnote.position = {
                        line: Number(lineIndex),
                        ch: Number(line.indexOf('[^'))
                    };
                    
                    footnotes.set(id, currentFootnote);
                }
                // 处理多行脚注内容
                else if (currentFootnote) {
                    if (line.startsWith('    ') || line.startsWith('\t')) {
                        // 移除缩进
                        currentContent.push(line.replace(/^(?:\t|    )/, ''));
                    } else if (line.trim() === '') {
                        // 保留空行
                        currentContent.push('');
                    } else {
                        // 非缩进非空行，结束当前脚注
                        const footnote = footnotes.get(currentFootnote.id);
                        if (footnote) {
                            footnote.content = currentContent.join('\n').trim();
                        }
                        currentFootnote = null;
                        currentContent = [];
                    }
                }
            });

            // 处理最后一个脚注
            if (currentFootnote) {
                const footnote = footnotes.get(currentFootnote.id);
                if (footnote) {
                    footnote.content = currentContent.join('\n').trim();
                }
            }

            // 转换为数组并按第一次引用的位置排序
            const result = Array.from(footnotes.values())
                .sort((a, b) => {
                    // 优先使用第一次引用的位置
                    const aPos = a.firstRef || a.position;
                    const bPos = b.firstRef || b.position;
                    
                    if (!aPos && !bPos) return 0;
                    if (!aPos) return 1;
                    if (!bPos) return -1;
                    
                    // 先按行号排序
                    if (aPos.line !== bPos.line) {
                        return aPos.line - bPos.line;
                    }
                    // 同一行按列位置排序
                    return aPos.ch - bPos.ch;
                });

            return result;
        } catch (error) {
            console.error('解析脚注时出错:', error);
            return [];
        }
    }

    async renderFootnotes(footnotes) {
        const container = this.containerEl.children[1];
        const footnotesContainer = container.querySelector('.footnotes-container');
        if (!footnotesContainer) return;

        footnotesContainer.addClass('loading');
        footnotesContainer.empty();

        try {
            this.footnoteElements.clear();

            if (!Array.isArray(footnotes) || footnotes.length === 0) {
                footnotesContainer.createEl('div', {
                    text: '当前文档没有脚注',
                    cls: 'footnote-empty'
                });
                return;
            }

            const activeFile = this.app.workspace.getActiveFile();
            if (!activeFile) return;

            // 按照引用顺序对脚注进行排序
            const sortedFootnotes = [...footnotes].sort((a, b) => {
                const aFirstRef = a.firstRef || a.position;
                const bFirstRef = b.firstRef || b.position;
                
                if (!aFirstRef && !bFirstRef) return 0;
                if (!aFirstRef) return 1;
                if (!bFirstRef) return -1;
                
                return aFirstRef.line - bFirstRef.line || aFirstRef.ch - bFirstRef.ch;
            });

            // 创建一个映射来存储脚注的序号
            const footnoteNumbers = new Map();
            sortedFootnotes.forEach((footnote, index) => {
                footnoteNumbers.set(footnote.id, index + 1);
            });

            // 渲染脚注
            sortedFootnotes.forEach(async (footnote) => {
                const footnoteEl = footnotesContainer.createEl('div', {
                    cls: 'footnote-item',
                    attr: {
                        'data-footnote-id': footnote.id
                    }
                });

                // 创建头部
                const header = footnoteEl.createEl('div', { cls: 'footnote-header' });

                // 添加脚注序号
                header.createEl('span', {
                    text: `[${footnoteNumbers.get(footnote.id)}]`,
                    cls: 'footnote-id'
                });

                /* 暂时隐藏编辑按钮
                // 添加编辑按钮
                const editButton = header.createEl('span', {
                    cls: 'footnote-edit-button',
                    attr: {
                        'aria-label': '编辑脚注'
                    }
                });
                this.addIcon(editButton, 'edit');
                */

                // 添加跳转到引用的图标
                if (footnote.references.length > 0) {
                    const refIcon = header.createEl('span', {
                        cls: 'footnote-ref-icon',
                        // attr: {
                        //     'aria-label': '跳转到引用'
                        // }
                    });
                    this.addIcon(refIcon, 'arrow-up-right');

                    refIcon.addEventListener('click', async () => {
                        try {
                            // 1. 获取当前文件
                            const activeFile = this.app.workspace.getActiveFile();
                            if (!activeFile) {
                                new Notice('请先打开文档');
                                return;
                            }

                            // 2. 获取当前活动的叶子
                            const leaves = this.app.workspace.getLeavesOfType('markdown');
                            const targetLeaf = leaves.find(leaf => 
                                leaf.view && leaf.view.file && leaf.view.file.path === activeFile.path
                            );

                            if (!targetLeaf) {
                                new Notice('请先打开编辑器视图');
                                return;
                            }

                            // 3. 获取编辑器
                            const view = targetLeaf.view;
                            const editor = view.editor;
                            if (!editor) {
                                new Notice('无法获取编辑器');
                                return;
                            }

                            // 4. 获取引用位置
                            const ref = footnote.references[0];
                            if (!ref || typeof ref.line === 'undefined' || typeof ref.ch === 'undefined') {
                                new Notice('找不到引用位置');
                                return;
                            }

                            // 5. 设置位置
                            const pos = {
                                line: Number(ref.line),
                                ch: Number(ref.ch)
                            };

                            // 6. 验证位置
                            if (pos.line < 0 || pos.line >= editor.lineCount()) {
                                new Notice('引用位置无效');
                                return;
                            }

                            // 7. 跳转并高亮
                            try {
                                // 激活编辑器
                                await this.app.workspace.setActiveLeaf(targetLeaf, true);
                                
                                // 等待编辑器准备就绪
                                await new Promise(resolve => setTimeout(resolve, 50));

                                // 跳转到位置
                                const range = {
                                    from: { line: pos.line, ch: pos.ch },
                                    to: { line: pos.line, ch: pos.ch + `[^${footnote.id}]`.length }
                                };

                                // 使用 setEphemeralState 设置编辑器状态
                                view.setEphemeralState({
                                    line: pos.line,
                                    ch: pos.ch,
                                    scroll: true,
                                    focus: true
                                });

                                // 高亮选择
                                editor.setSelection(range.from, range.to);

                                // 3秒后清除高亮
                                setTimeout(() => {
                                    if (editor.somethingSelected()) {
                                        editor.setCursor(editor.getCursor('head'));
                                    }
                                }, 3000);

                            } catch (error) {
                                console.error('跳转或高亮时出错:', error);
                                new Notice('跳转失败');
                            }

                        } catch (error) {
                            console.error('跳转到引用位置时出错:', error);
                            new Notice('跳转失败');
                        }
                    });
                }

                // 添加全屏按钮
                const fullscreenButton = header.createEl('span', {
                    cls: 'footnote-fullscreen-button',
                    attr: {
                        'aria-label': '全屏预览'
                    }
                });
                this.addIcon(fullscreenButton, 'maximize-2');

                // 添加全屏按钮点击事件
                fullscreenButton.addEventListener('click', () => {
                    const modal = new FullscreenPreviewModal(this.app, footnote.content, activeFile);
                    modal.open();
                });

                // 创建内容容器
                const contentWrapper = footnoteEl.createEl('div', {
                    cls: 'footnote-content-wrapper'
                });

                // 创建预览模式内容
                const contentEl = contentWrapper.createEl('div', {
                    cls: 'footnote-content markdown-rendered'
                });

                // 添加展开/收起按钮
                const expandButton = contentWrapper.createEl('div', {
                    cls: 'footnote-expand-button',
                    text: '展开'
                });

                // 处理展开/收起逻辑
                expandButton.addEventListener('click', () => {
                    const isExpanded = contentEl.hasClass('expanded');
                    if (isExpanded) {
                        contentEl.removeClass('expanded');
                        expandButton.textContent = '展开';
                        // 滚动到卡片顶部
                        contentEl.scrollIntoView({ behavior: 'smooth' });
                    } else {
                        contentEl.addClass('expanded');
                        expandButton.textContent = '收起';
                    }
                });

                // 检查内容高度，如果不需要展开按钮则隐藏
                setTimeout(() => {
                    if (contentEl.scrollHeight <= 100) {
                        expandButton.style.display = 'none';
                    }
                }, 100);

                // 处理图片路径
                let processedContent = footnote.content;
                if (activeFile) {
                    // 处理 Markdown 图片语法
                    processedContent = processedContent.replace(
                        /!\[(.*?)\]\((.*?)\)/g,
                        (match, alt, path) => {
                            if (path.startsWith('http')) {
                                return match;
                            }

                            try {
                                const targetFile = this.app.metadataCache.getFirstLinkpathDest(
                                    decodeURIComponent(path.trim()),
                                    activeFile.path
                                );

                                if (targetFile) {
                                    const resourcePath = this.app.vault.getResourcePath(targetFile);
                                    return `![${alt}](${resourcePath})`;
                                }
                            } catch (error) {
                                console.error('处理图片路径时出错:', error);
                            }
                            return match;
                        }
                    );

                    // 处理 Wiki 链接图片
                    processedContent = processedContent.replace(
                        /!\[\[(.*?)\]\]/g,
                        (match, path) => {
                            try {
                                const [actualPath] = path.split('|');
                                const targetFile = this.app.metadataCache.getFirstLinkpathDest(
                                    decodeURIComponent(actualPath.trim()),
                                    activeFile.path
                                );

                                if (targetFile) {
                                    const resourcePath = this.app.vault.getResourcePath(targetFile);
                                    return `![${path}](${resourcePath})`;
                                }
                            } catch (error) {
                                console.error('处理 Wiki 链接图片时出错:', error);
                            }
                            return match;
                        }
                    );
                }

                // 渲染 Markdown 内容
                try {
                    const { MarkdownRenderer } = require('obsidian');
                    await MarkdownRenderer.renderMarkdown(
                        processedContent,
                        contentEl,
                        activeFile.path,
                        this
                    );

                    // 处理渲染后的图片元素
                    contentEl.querySelectorAll('img').forEach(img => {
                        // 添加加载错误处理
                        img.onerror = () => {
                            console.error('图片加载失败:', img.src);
                            img.style.border = '1px solid var(--text-error)';
                            img.title = '图片加载失败';
                        };

                        // 添加点击放大功能
                        img.addEventListener('click', () => {
                            const originalSrc = img.getAttribute('src');
                            const modal = new ImageModal(this.app, originalSrc);
                            modal.open();
                        });

                        // 设置样式
                        img.style.maxWidth = '100%';
                        img.style.height = 'auto';
                        img.style.cursor = 'zoom-in';
                    });
                } catch (error) {
                    console.error('渲染 Markdown 内容时出错:', error);
                    contentEl.setText('渲染内容时出错');
                }

                // 保存元素引用
                this.footnoteElements.set(footnote.id, footnoteEl);
            });
        } catch (error) {
            console.error('渲染脚注时出错:', error);
            footnotesContainer.createEl('div', {
                text: '渲染脚注时出错',
                cls: 'footnote-error'
            });
        } finally {
            footnotesContainer.removeClass('loading');
        }
    }

    // 添加一个辅助方法来设置图标
    addIcon(element, iconId) {
        const iconEl = element.createEl('div', { cls: 'svg-icon' });
        setIcon(iconEl, iconId);
        return iconEl;
    }

    async handleEditorClick(editor, event) {
        if (!editor) return;

        // 阻止默认行为和事件传播
        event.preventDefault();
        event.stopPropagation();

        // 保存当前滚动位置
        const currentScroll = editor.getScrollInfo().top;

        try {
            // 获取点击位置的坐标
            const pos = editor.posAtMouse(event);
            if (!pos) return;

            // 获取点击位置的文本内容和上下文
            const lineContent = editor.getLine(pos.line);
            const clickPosition = pos.ch;

            // 在点击位置前后查找脚注引用
            const beforeText = lineContent.substring(0, clickPosition + 1);
            const afterText = lineContent.substring(clickPosition);

            // 向前查找最近的 [^
            const startMatch = beforeText.match(/\[\^[^\]]*$/);
            // 向后查找最近的 ]
            const endMatch = afterText.match(/^[^\[]*\]/);

            let footnoteId = null;

            if (startMatch && endMatch) {
                // 提取完整的脚注引用
                const fullMatch = (beforeText + afterText).substring(
                    startMatch.index,
                    beforeText.length + endMatch.index + 1
                );

                // 检查是否是有效的脚注引用格式
                const footnoteMatch = fullMatch.match(/\[\^([^\]]+)\]/);
                if (footnoteMatch) {
                    footnoteId = footnoteMatch[1];
                }
            }

            if (!footnoteId) return;

            // 确保面板可见
            const leaf = this.app.workspace.getLeavesOfType(FOOTNOTES_VIEW_TYPE)[0];
            if (!leaf) {
                await this.app.workspace.getRightLeaf(false).setViewState({
                    type: FOOTNOTES_VIEW_TYPE,
                    active: true,
                });
            }
            await this.app.workspace.revealLeaf(
                this.app.workspace.getLeavesOfType(FOOTNOTES_VIEW_TYPE)[0]
            );

            // 高亮并滚动到对应的脚注
            const footnoteEl = this.footnoteElements.get(footnoteId);
            if (footnoteEl) {
                // 移除所有高亮
                this.footnoteElements.forEach(el => {
                    el.removeClass('footnote-highlight-panel');
                    el.removeClass('footnote-highlight-panel-flash');
                });

                // 添加高亮效果
                footnoteEl.addClass('footnote-highlight-panel');
                footnoteEl.addClass('footnote-highlight-panel-flash');

                // 滚动到对应位置
                const container = this.containerEl.querySelector('.footnotes-container');
                if (container) {
                    // 使用原生滚动
                    const containerRect = container.getBoundingClientRect();
                    const elementRect = footnoteEl.getBoundingClientRect();
                    const scrollTop = container.scrollTop + 
                        (elementRect.top - containerRect.top) - 
                        (containerRect.height - elementRect.height) / 2;

                    container.scrollTo({
                        top: scrollTop,
                        behavior: 'smooth'
                    });
                }

                // 移除闪烁效果
                setTimeout(() => {
                    footnoteEl.removeClass('footnote-highlight-panel-flash');
                }, 2000);
            }

            // 恢复文档滚动位置
            requestAnimationFrame(() => {
                editor.scrollTo(null, currentScroll);
            });
        } catch (error) {
            console.error('处理点击事件时出错:', error);
            editor.scrollTo(null, currentScroll);
        }
    }

    // 新增方法：高亮脚注
    async highlightFootnote(footnoteId) {
        try {
            // 确保面板可见
            const leaf = this.app.workspace.getLeavesOfType(FOOTNOTES_VIEW_TYPE)[0];
            if (!leaf) {
                await this.app.workspace.getRightLeaf(false).setViewState({
                    type: FOOTNOTES_VIEW_TYPE,
                    active: true,
                });
            }
            await this.app.workspace.revealLeaf(
                this.app.workspace.getLeavesOfType(FOOTNOTES_VIEW_TYPE)[0]
            );

            // 高亮并滚动到对应的脚注
            const footnoteEl = this.footnoteElements.get(footnoteId);
            if (footnoteEl) {
                // 移除所有高亮
                this.footnoteElements.forEach(el => {
                    el.removeClass('footnote-highlight-panel');
                    el.removeClass('footnote-highlight-panel-flash');
                });

                // 添加高亮效果
                footnoteEl.addClass('footnote-highlight-panel');
                footnoteEl.addClass('footnote-highlight-panel-flash');

                // 滚动到对应位置
                const container = this.containerEl.querySelector('.footnotes-container');
                if (container) {
                    const containerRect = container.getBoundingClientRect();
                    const elementRect = footnoteEl.getBoundingClientRect();
                    const scrollTop = container.scrollTop + 
                        (elementRect.top - containerRect.top) - 
                        (containerRect.height - elementRect.height) / 2;

                    container.scrollTo({
                        top: scrollTop,
                        behavior: 'smooth'
                    });
                }

                // 移除闪烁效果
                setTimeout(() => {
                    footnoteEl.removeClass('footnote-highlight-panel-flash');
                }, 2000);
            }
        } catch (error) {
            console.error('高亮脚注时出错:', error);
        }
    }

    // 添加更新脚注内容的方法
    async updateFootnoteContent(footnoteId, newContent) {
        try {
            const activeFile = this.app.workspace.getActiveFile();
            if (!activeFile) return;

            const content = await this.app.vault.read(activeFile);
            const lines = content.split('\n');

            // 找到脚注定义的位置
            const footnote = this.footnotes.find(f => f.id === footnoteId);
            if (!footnote || !footnote.position) return;

            // 更新脚注内容
            const indentation = '    '; // 4个空格的缩进
            const newLines = newContent.split('\n').map((line, index) => {
                return index === 0 ? 
                    `[^${footnoteId}]: ${line}` : 
                    `${indentation}${line}`;
            });

            // 替换原有内容
            let startLine = footnote.position.line;
            let endLine = startLine;

            // 找到脚注定义的结束位置
            while (endLine < lines.length - 1 && 
                   (lines[endLine + 1].startsWith(indentation) || lines[endLine + 1].trim() === '')) {
                endLine++;
            }

            // 替换内容
            lines.splice(startLine, endLine - startLine + 1, ...newLines);

            // 写入文件
            await this.app.vault.modify(activeFile, lines.join('\n'));

            // 更新面板
            await this.updateFootnotes();

            // 添加额外的延迟更新，确保内容完全保存后再次更新
            setTimeout(async () => {
                await this.updateFootnotes();
            }, 500);
        } catch (error) {
            console.error('更新脚注内容时出错:', error);
            new Notice('更新脚注内容时出错');
        }
    }
}

module.exports = class FootnotesPlugin extends Plugin {
    async onload() {
        this.registerView(
            FOOTNOTES_VIEW_TYPE,
            (leaf) => new FootnotesView(leaf)
        );

        // 添加桌面端图标 - 更换为 message-square 图标
        if (!Platform.isMobile) {
            this.addRibbonIcon('message-square', '显示脚注面板', () => {
                this.activateView();
            });
        }

        // 添加命令（同时支持桌面端和移动端）
        this.addCommand({
            id: 'show-footnotes-panel',
            name: '显示脚注面板',
            icon: 'message-square', // 同样更新命令的图标
            callback: () => {
                this.activateView();
            },
        });

        // 为移动端添加工具栏按钮
        if (Platform.isMobile) {
            this.registerEvent(
                this.app.workspace.on('layout-ready', () => {
                    this.addMobileToolbarButton();
                })
            );
        }
    }

    async onunload() {
        this.app.workspace.detachLeavesOfType(FOOTNOTES_VIEW_TYPE);
        const editor = this.app.workspace.activeEditor?.editor;
        if (editor?.cm?.dom && editor.cm.dom._footnoteClickHandler) {
            editor.cm.dom.removeEventListener('click', editor.cm.dom._footnoteClickHandler, true);
        }
    }

    async activateView() {
        const { workspace } = this.app;
        let leaf = workspace.getLeavesOfType(FOOTNOTES_VIEW_TYPE)[0];

        if (!leaf) {
            if (Platform.isMobile) {
                // 移动端使用叠加模式
                leaf = workspace.getLeaf('popup');
            } else {
                // 桌面端使用右侧面板
                leaf = workspace.getRightLeaf(false);
            }
            
            await leaf.setViewState({
                type: FOOTNOTES_VIEW_TYPE,
                active: true,
            });
        }

        workspace.revealLeaf(leaf);
    }

    // 更新移动端工具栏按钮的图标
    addMobileToolbarButton() {
        const mobileToolbar = this.app.workspace.containerEl.querySelector('.mobile-toolbar');
        if (!mobileToolbar) return;

        const button = mobileToolbar.createEl('div', {
            cls: 'mobile-toolbar-button',
            attr: {
                'aria-label': '显示脚注面板'
            }
        });
        
        setIcon(button, 'message-square'); // 更新移动端按钮图标
        
        button.addEventListener('click', () => {
            this.activateView();
        });
    }
}

// 图片模态框类
class ImageModal extends Modal {
    constructor(app, imageSrc) {
        super(app);
        this.imageSrc = imageSrc;
    }

    onOpen() {
        const {contentEl} = this;
        const img = contentEl.createEl('img', {
            attr: {
                src: this.imageSrc,
                style: 'max-width: 100%; max-height: 80vh; object-fit: contain;'
            }
        });
    }

    onClose() {
        const {contentEl} = this;
        contentEl.empty();
    }
}

// 修改全屏预览模态框类
class FullscreenPreviewModal extends Modal {
    constructor(app, content, activeFile) {
        super(app);
        this.content = content;
        this.activeFile = this.app.workspace.getActiveFile(); // 获取当前文件
    }

    onOpen() {
        const {contentEl} = this;
        contentEl.addClass('footnote-fullscreen-modal');
        
        // 创建内容容器
        const container = contentEl.createEl('div', {
            cls: 'footnote-fullscreen-content markdown-rendered'
        });

        // 处理图片路径
        let processedContent = this.content;
        if (this.activeFile) {
            // 处理 Markdown 图片语法
            processedContent = processedContent.replace(
                /!\[(.*?)\]\((.*?)\)/g,
                (match, alt, path) => {
                    if (path.startsWith('http')) {
                        return match;
                    }

                    try {
                        const targetFile = this.app.metadataCache.getFirstLinkpathDest(
                            decodeURIComponent(path.trim()),
                            this.activeFile.path
                        );

                        if (targetFile) {
                            const resourcePath = this.app.vault.getResourcePath(targetFile);
                            return `![${alt}](${resourcePath})`;
                        }
                    } catch (error) {
                        console.error('处理图片路径时出错:', error);
                    }
                    return match;
                }
            );

            // 处理 Wiki 链接图片
            processedContent = processedContent.replace(
                /!\[\[(.*?)\]\]/g,
                (match, path) => {
                    try {
                        const [actualPath] = path.split('|');
                        const targetFile = this.app.metadataCache.getFirstLinkpathDest(
                            decodeURIComponent(actualPath.trim()),
                            this.activeFile.path
                        );

                        if (targetFile) {
                            const resourcePath = this.app.vault.getResourcePath(targetFile);
                            return `![${path}](${resourcePath})`;
                        }
                    } catch (error) {
                        console.error('处理 Wiki 链接图片时出错:', error);
                    }
                    return match;
                }
            );
        }

        // 渲染 Markdown 内容
        const { MarkdownRenderer } = require('obsidian');
        MarkdownRenderer.renderMarkdown(
            processedContent,
            container,
            this.activeFile?.path || '',
            this
        ).then(() => {
            // 处理图片预览
            container.querySelectorAll('img').forEach(img => {
                // 添加加载错误处理
                img.onerror = () => {
                    console.error('图片加载失败:', img.src);
                    img.style.border = '1px solid var(--text-error)';
                    img.title = '图片加载失败';
                };

                // 添加点击放大功能
                img.addEventListener('click', () => {
                    const originalSrc = img.getAttribute('src');
                    const imageModal = new ImageModal(this.app, originalSrc);
                    imageModal.open();
                });

                // 设置样式
                img.style.maxWidth = '100%';
                img.style.height = 'auto';
                img.style.cursor = 'zoom-in';
            });
        });
    }

    onClose() {
        const {contentEl} = this;
        contentEl.empty();
    }
} 