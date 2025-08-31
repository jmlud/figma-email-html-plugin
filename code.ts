// src/code.ts (VERSÃO FINAL, COMPLETA E CORRIGIDA)

// --- Funções Utilitárias e Classes Auxiliares ---

function figmaColorToHex(color: RGB): string {
  const toHex = (c: number) => ('0' + Math.round(c * 255).toString(16)).slice(-2);
  return `#${toHex(color.r)}${toHex(color.g)}${toHex(color.b)}`;
}

async function textStyleToInline(node: TextNode): Promise<string> {
  const styles: string[] = [];
  // Carregar a fonte é uma operação assíncrona
  await figma.loadFontAsync(node.fontName as FontName);

  const fontFamily = (node.fontName as FontName).family;
  const fontSize = node.fontSize as number;
  const fontWeight = (node.fontName as FontName).style.toLowerCase().includes('bold') ? '700' : '400';
  const textAlign = (node.textAlignHorizontal || 'LEFT').toLowerCase();
  const letterSpacing = node.letterSpacing as LetterSpacing;
  const lineHeight = node.lineHeight as LineHeight;

  styles.push(`font-family:${fontFamily}, Arial, sans-serif`);
  styles.push(`font-size:${Math.round(fontSize)}px`);
  styles.push(`font-weight:${fontWeight}`);
  styles.push(`text-align:${textAlign}`);
  
  if (letterSpacing && letterSpacing.value !== 0) {
    styles.push(`letter-spacing:${(letterSpacing.value / fontSize).toFixed(2)}em`);
  }
  if (lineHeight && lineHeight.unit !== 'AUTO') {
    styles.push(`line-height:${Math.round(lineHeight.value)}px`);
  }

  if (Array.isArray(node.fills) && node.fills.length > 0) {
    const fill = node.fills[0];
    if (fill.type === 'SOLID') {
      styles.push(`color:${figmaColorToHex(fill.color)}`);
    }
  }
  
  return styles.join(';');
}

class ContentBlock {
  public htmlContent: string[] = [];
  public type: 'text' | 'other' | null = null;
  public style: string = '';

  add(html: string, type: 'text' | 'other', style: string = '') {
    if (!this.type) {
      this.type = type;
      if (type === 'text') this.style = style;
    }
    this.htmlContent.push(html);
  }

  get isText(): boolean { return this.type === 'text'; }
  get isEmpty(): boolean { return this.htmlContent.length === 0; }

  render(): string {
    if (this.isEmpty) return '';
    return this.isText ? this.htmlContent.join('<br />') : this.htmlContent.join('');
  }
}


// --- O PARSER AVANÇADO PARA O PLUGIN ---

class FigmaPluginParser {

  private async renderNode(node: SceneNode): Promise<string> {
    if (!node.visible) return '';
    
    const isImageNode = node.type === 'RECTANGLE' && node.name.match(/\.(jpg|jpeg|png|gif)$/i);
    if (isImageNode) {
        return this.renderImagePlaceholder(node);
    }
    
    switch (node.type) {
      case 'FRAME':
      case 'GROUP':
      case 'COMPONENT':
      case 'INSTANCE':
        return this.renderContainer(node);
      case 'RECTANGLE':
      case 'ELLIPSE':
        return this.renderShape(node);
      case 'TEXT':
        return this.renderText(node);
      default:
        return `<!-- Nó do tipo '${node.type}' não suportado -->`;
    }
  }

  private async renderContainer(node: FrameNode | GroupNode | ComponentNode | InstanceNode): Promise<string> {
    if (!('children' in node) || node.children.length === 0) {
        return this.renderShape(node as FrameNode);
    }

    const nodeWidth = node.width;
    const fills = (node as FrameNode | ComponentNode | InstanceNode).fills;
    const bgColorFill = 'fills' in node && Array.isArray(fills) ? (fills.find(f => f.type === 'SOLID') as SolidPaint) : undefined;
    const bgColor = bgColorFill ? figmaColorToHex(bgColorFill.color) : undefined;

    const paddingTop = 'paddingTop' in node ? node.paddingTop : 0;
    const paddingBottom = 'paddingBottom' in node ? node.paddingBottom : 0;
    const layoutMode = 'layoutMode' in node ? node.layoutMode : 'NONE';

    let innerHtml = '';
    if (layoutMode === 'HORIZONTAL') {
        innerHtml = await this.renderHorizontalChildren(node as FrameNode);
    } else {
        innerHtml = await this.renderStackedChildren(node);
    }

    const tableStyle = bgColor ? `background-color:${bgColor};` : '';
    const tableBgColor = bgColor ? `bgcolor="${bgColor}"` : '';

    const paddingTopHtml = paddingTop > 0 ? `<tr><td height="${paddingTop}" style="font-size:1px; line-height:${paddingTop}px;">&nbsp;</td></tr>` : '';
    const paddingBottomHtml = paddingBottom > 0 ? `<tr><td height="${paddingBottom}" style="font-size:1px; line-height:${paddingBottom}px;">&nbsp;</td></tr>` : '';
    const contentRowHtml = innerHtml.trim() !== '' ? `<tr><td>${innerHtml}</td></tr>` : '';
    
    const finalInnerHtml = `${paddingTopHtml}${contentRowHtml}${paddingBottomHtml}`;

    return `<table width="${Math.round(nodeWidth)}" border="0" cellpadding="0" cellspacing="0" style="${tableStyle}" ${tableBgColor}>${finalInnerHtml}</table>`;
  }
  
  private async renderStackedChildren(parentNode: FrameNode | GroupNode | ComponentNode | InstanceNode): Promise<string> {
    const children = [...parentNode.children].sort((a, b) => a.y - b.y);
    const rows: string[] = [];
    let currentBlock = new ContentBlock();
    let lastBottomY = children.length > 0 ? children[0].y : 0;

    const paddingLeft = 'paddingLeft' in parentNode ? parentNode.paddingLeft : 0;
    const paddingRight = 'paddingRight' in parentNode ? parentNode.paddingRight : 0;
    
    const flushBlock = () => {
      if (currentBlock.isEmpty) return;
      const content = currentBlock.render();
      let paddingStyle = '';
      if (paddingLeft > 0) paddingStyle += `padding-left:${paddingLeft}px;`;
      if (paddingRight > 0) paddingStyle += `padding-right:${paddingRight}px;`;
      
      const finalStyle = currentBlock.isText ? `${currentBlock.style}${paddingStyle}` : paddingStyle;
      rows.push(`<tr><td style="${finalStyle}" valign="top">${content}</td></tr>`);
      currentBlock = new ContentBlock();
    };

    for (const child of children) {
      if (!child.visible) continue;

      const verticalGap = child.y - lastBottomY;
      if (verticalGap > 5) {
        flushBlock();
        rows.push(`<tr><td height="${Math.round(verticalGap)}" style="font-size:1px; line-height:${Math.round(verticalGap)}px;">&nbsp;</td></tr>`);
      }
      
      const isText = child.type === 'TEXT';
      if (!currentBlock.isText && isText) flushBlock();
      if (currentBlock.isText && !isText) flushBlock();
      if (!isText) flushBlock();
      
      let childHtml = '';
      let childStyle = '';
      if (child.type === 'TEXT') {
        childHtml = child.characters.replace(/\n/g, '<br />');
        childStyle = await textStyleToInline(child);
      } else {
        childHtml = await this.renderNode(child);
      }
      
      currentBlock.add(childHtml, isText ? 'text' : 'other', childStyle);
      lastBottomY = child.y + child.height;
    }
    flushBlock();
    return `<table width="100%" border="0" cellpadding="0" cellspacing="0">${rows.join('')}</table>`;
  }
  
  private async renderHorizontalChildren(parentNode: FrameNode): Promise<string> {
      const children = [...parentNode.children].sort((a, b) => a.x - b.x);
      const cols: string[] = [];
      const itemSpacing = 'itemSpacing' in parentNode ? parentNode.itemSpacing : 0;
      const paddingLeft = 'paddingLeft' in parentNode ? parentNode.paddingLeft : 0;
      const paddingRight = 'paddingRight' in parentNode ? parentNode.paddingRight : 0;
      
      if (paddingLeft > 0) cols.push(`<td width="${paddingLeft}">&nbsp;</td>`);

      for (let i = 0; i < children.length; i++) {
          const child = children[i];
          if (!child.visible) continue;
          const childHtml = await this.renderNode(child);
          cols.push(`<td valign="top">${childHtml}</td>`);
          
          if (itemSpacing > 0 && i < children.length - 1) {
              cols.push(`<td width="${itemSpacing}">&nbsp;</td>`);
          }
      }

      if (paddingRight > 0) cols.push(`<td width="${paddingRight}">&nbsp;</td>`);

      return `<table border="0" cellpadding="0" cellspacing="0"><tr>${cols.join('')}</tr></table>`;
  }
  
  private async renderText(node: TextNode): Promise<string> {
    if (!node.characters?.trim()) return '';
    const styles = await textStyleToInline(node);
    const content = node.characters.replace(/\n/g, '<br />');
    return `<table width="100%" border="0" cellpadding="0" cellspacing="0"><tr><td style="${styles}" valign="top">${content}</td></tr></table>`;
  }

  private renderShape(node: SceneNode): string {
    const { width, height } = node;
    const fills = (node as RectangleNode).fills;
    const fill = 'fills' in node && Array.isArray(fills) ? (fills.find(f => f.type === 'SOLID') as SolidPaint) : undefined;
    const bgColor = fill ? `bgcolor="${figmaColorToHex(fill.color)}"` : '';
    return `<table width="${Math.round(width)}" height="${Math.round(height)}" border="0" cellpadding="0" cellspacing="0"><tr><td ${bgColor} style="font-size:1px; line-height:1px;">&nbsp;</td></tr></table>`;
  }

  private renderImagePlaceholder(node: SceneNode): string {
    const { width, height } = node;
    const url = `https://placehold.co/${Math.round(width)}x${Math.round(height)}/EFEFEF/7F7F7F?text=${encodeURIComponent(node.name || `${Math.round(width)}x${Math.round(height)}`)}`;
    return `<img src="${url}" width="${Math.round(width)}" alt="${node.name}" style="display: block; border: 0; width: ${Math.round(width)}px; height: auto;" />`;
  }

  public async parse(nodes: readonly SceneNode[]): Promise<string> {
    
    // --- LÓGICA DE MÚLTIPLAS SELEÇÕES AQUI ---
    if (nodes.length === 0) {
      return '';
    }
    
    // Se apenas um nó for selecionado, o comportamento é o mesmo de antes.
    if (nodes.length === 1) {
      const html = await this.renderNode(nodes[0]);
      // A limpeza final aplica-se aqui também
      let cleanedHtml = html.replace(/<\/?tbody>/g, '');
      cleanedHtml = cleanedHtml.replace(/<tr[^>]*>\s*<td[^>]*>\s*<\/td>\s*<\/tr>/g, '');
      cleanedHtml = cleanedHtml.replace(/<tr[^>]*>\s*<\/tr>/g, '');
      return cleanedHtml;
    }

    // Se MÚLTIPLOS nós forem selecionados:
    // 1. Ordena os nós selecionados de cima para baixo.
    const sortedNodes = [...nodes].sort((a, b) => a.y - b.y);
    
    const rows: string[] = [];
    let lastBottomY = 0;

    // 2. Itera sobre os nós ordenados para criar o empilhamento vertical.
    for (let i = 0; i < sortedNodes.length; i++) {
      const node = sortedNodes[i];
      
      // Calcula o espaço vertical entre este nó e o anterior.
      if (i > 0) {
        const gap = node.y - lastBottomY;
        if (gap > 2) {
          rows.push(`<tr><td height="${Math.round(gap)}" style="font-size:1px; line-height:${Math.round(gap)}px;">&nbsp;</td></tr>`);
        }
      }

      // Renderiza o nó individualmente.
      const nodeHtml = await this.renderNode(node);
      rows.push(`<tr><td>${nodeHtml}</td></tr>`);
      
      // Atualiza a posição do "fundo" do último elemento renderizado.
      lastBottomY = node.y + node.height;
    }

    // 3. Envolve tudo numa única tabela.
    const finalHtml = `<table width="100%" border="0" cellpadding="0" cellspacing="0">${rows.join('')}</table>`;

    // 4. Aplica a limpeza final.
    let cleanedHtml = finalHtml.replace(/<\/?tbody>/g, '');
    cleanedHtml = cleanedHtml.replace(/<tr[^>]*>\s*<td[^>]*>\s*<\/td>\s*<\/tr>/g, '');
    cleanedHtml = cleanedHtml.replace(/<tr[^>]*>\s*<\/tr>/g, '');
    
    return cleanedHtml;
  }
}

// --- Lógica Principal do Plugin ---

figma.showUI(__html__, { width: 400, height: 450 });

figma.ui.onmessage = async (msg: { type: string; [key: string]: unknown }) => {
  if (msg.type === 'generate-html-for-selection') {
    const selectedNodes = figma.currentPage.selection;

    if (selectedNodes.length === 0) {
      figma.notify("Por favor, selecione pelo menos um elemento.");
      figma.ui.postMessage({ type: 'generated-html', payload: '' });
      return;
    }

    const parser = new FigmaPluginParser();
    const html = await parser.parse(selectedNodes);
    
    figma.ui.postMessage({ type: 'generated-html', payload: html });
  }

  if (msg.type === 'notify') {
    if (typeof msg.message === 'string') {
      figma.notify(msg.message);
    }
  }
};