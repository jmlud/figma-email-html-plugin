const bulletCharacterMap: { [key: string]: string } = {
  '•': '&#8226;',
  '*': '&#8226;',
  '-': '&#8211;',
};

// --- NOVAS FUNÇÕES AUXILIARES ---

/**
 * Mistura uma cor de primeiro plano com opacidade sobre uma cor de fundo sólida.
 * @param fgFill O preenchimento do primeiro plano (com cor e opacidade).
 * @param bgRgb A cor de fundo sólida (no formato {r, g, b}).
 * @returns A cor hexadecimal final e sólida.
 */
function blendAndGetSolidHex(fgFill: SolidPaint, bgRgb: RGB): string {
  const fgRgb = fgFill.color;
  const alpha = fgFill.opacity ?? 1;

  // Fórmula de Alpha Blending: C = C_fg * α + C_bg * (1 - α)
  const r = fgRgb.r * alpha + bgRgb.r * (1 - alpha);
  const g = fgRgb.g * alpha + bgRgb.g * (1 - alpha);
  const b = fgRgb.b * alpha + bgRgb.b * (1 - alpha);

  return figmaColorToHex({ r, g, b });
}

/**
 * Percorre a hierarquia de nós a partir de um nó para encontrar a cor de fundo sólida mais próxima.
 * @param node O nó a partir do qual a busca começa.
 * @returns A cor de fundo sólida no formato {r, g, b}. Retorna branco como padrão.
 */
function findBackgroundColor(node: SceneNode): RGB {
  let parent = node.parent;
  while (parent && parent.type !== 'PAGE') {
    if ('fills' in parent && Array.isArray(parent.fills) && parent.fills.length > 0) {
      const solidFill = parent.fills.find(f => f.type === 'SOLID' && f.visible) as SolidPaint;
      if (solidFill && (solidFill.opacity ?? 1) === 1) {
        return solidFill.color; 
      }
    }
    parent = parent.parent;
  }
  return { r: 1, g: 1, b: 1 }; 
}


function figmaColorToHex(color: RGB): string {
  const toHex = (c: number) => ('0' + Math.round(c * 255).toString(16)).slice(-2);
  return `#${toHex(color.r)}${toHex(color.g)}${toHex(color.b)}`;
}

function hasVisualProperties(node: SceneNode): boolean {
    if ('fills' in node && Array.isArray(node.fills) && node.fills.some(f => f.visible !== false && f.opacity !== 0)) {
        return true;
    }
    if ('paddingTop' in node && (node.paddingTop > 0 || node.paddingBottom > 0 || node.paddingLeft > 0 || node.paddingRight > 0)) {
        return true;
    }
    return false;
}

function isPotentialCta(node: SceneNode): node is FrameNode | GroupNode {
  if (node.type !== 'FRAME' && node.type !== 'GROUP') return false;
  if (node.children.length !== 2) return false;
  const hasText = node.children.some(child => child.type === 'TEXT');
  const hasShape = node.children.some(child => child.type === 'RECTANGLE' || child.type === 'ELLIPSE');
  return hasText && hasShape;
}

function isBulletPoint(node: SceneNode): node is FrameNode {
  if (node.type !== 'FRAME' || !node.visible) {
    return false;
  }
  if (node.layoutMode !== 'HORIZONTAL' || node.children.length !== 2) {
    return false;
  }
  const [firstChild, secondChild] = node.children;
  if (firstChild.type !== 'TEXT' || secondChild.type !== 'TEXT') {
    return false;
  }
  const bulletChar = firstChild.characters.trim();
  return bulletChar.length === 1 && bulletChar in bulletCharacterMap;
}

class FigmaPluginParser {
  private confirmedCtaIds: Set<string> = new Set();

  public setConfirmedCtaIds(ids: string[]) {
    this.confirmedCtaIds = new Set(ids);
  }

  private getSolidHexForFill(fill: SolidPaint, node: SceneNode): string {
    const opacity = fill.opacity ?? 1;
    if (opacity < 1) {
      const parentBg = findBackgroundColor(node);
      return blendAndGetSolidHex(fill, parentBg);
    }
    return figmaColorToHex(fill.color);
  }

  private async renderNode(node: SceneNode): Promise<string> {
    if (!node.visible) return ``;
    
    switch (node.type) {
      case 'FRAME':
      case 'GROUP':
      case 'COMPONENT':
      case 'INSTANCE':
        if (this.confirmedCtaIds.has(node.id) && isPotentialCta(node)) {
            return this.renderCta(node);
        }
        if (isBulletPoint(node)) {
            return this.renderBulletPoint(node);
        }
        return this.renderContainer(node);
      
      case 'RECTANGLE':
        if (node.name.match(/\.(jpg|jpeg|png|gif)$/i)) {
            return this.renderImagePlaceholder(node);
        }
        return this.renderShape(node);
      
      case 'ELLIPSE':
        return this.renderShape(node);

      case 'TEXT':
        return this.renderText(node);

      default:
        return ``;
    }
  }

  private async renderBulletPoint(node: FrameNode): Promise<string> {
      const bulletNode = node.children[0] as TextNode;
      const textNode = node.children[1] as TextNode;
      const spacerWidth = node.itemSpacing || 8;
      const bulletHtml = await this.renderStyledTextSegmentsToHtml(bulletNode);
      const textHtml = await this.renderStyledTextSegmentsToHtml(textNode);
      return `<tr><td style="text-align: left;" valign="top">${bulletHtml}</td><td width="${spacerWidth}">&nbsp;</td><td style="text-align: left;" valign="top">${textHtml}</td></tr>`;
  }

  private async renderCta(node: FrameNode | GroupNode): Promise<string> {
    const shapeNode = node.children.find(n => n.type === 'RECTANGLE' || n.type === 'ELLIPSE') as RectangleNode;
    const textNode = node.children.find(n => n.type === 'TEXT') as TextNode;
    const fill = shapeNode.fills && Array.isArray(shapeNode.fills) ? (shapeNode.fills.find(f => f.type === 'SOLID' && f.visible) as SolidPaint) : undefined;
    const bgColor = fill ? this.getSolidHexForFill(fill, shapeNode) : '#6D28D9'; // AJUSTADO
    const borderRadius = shapeNode.cornerRadius && typeof shapeNode.cornerRadius === 'number' ? shapeNode.cornerRadius : 6;
    const textSegments = textNode.getStyledTextSegments(['fontName', 'fontSize', 'fills']);
    await figma.loadFontAsync(textSegments[0].fontName);
    const textFill = textSegments[0].fills && Array.isArray(textSegments[0].fills) ? (textSegments[0].fills.find(f => f.type === 'SOLID') as SolidPaint) : undefined;
    const textColor = textFill ? this.getSolidHexForFill(textFill, textNode) : '#FFFFFF'; // AJUSTADO
    const { family, style } = textSegments[0].fontName;
    const fontWeight = style.toLowerCase().includes('bold') ? '700' : '400';
    const fontSize = Math.round(textSegments[0].fontSize);
    const href = '#';
    return `<table border="0" cellpadding="0" cellspacing="0" role="presentation"><tr><td align="center" style="border-radius: ${borderRadius}px; background: ${bgColor};" bgcolor="${bgColor}"><a href="${href}" target="_blank" style="font-family: ${family}, Arial, sans-serif; font-size: ${fontSize}px; font-weight: ${fontWeight}; color: ${textColor}; text-decoration: none; padding: 12px 24px; border-radius: ${borderRadius}px; display: inline-block;">${textNode.characters}</a></td></tr></table>`;
  }

  private async renderContainer(node: FrameNode | GroupNode | ComponentNode | InstanceNode): Promise<string> {
    if (!('children' in node)) {
        return this.renderShape(node as FrameNode);
    }
    const visibleChildren = node.children.filter(child => child.visible);
    if (visibleChildren.length === 0) {
      return this.renderShape(node as FrameNode);
    }
    if (visibleChildren.length === 1 && !hasVisualProperties(node)) {
        return this.renderNode(visibleChildren[0]);
    }

    const nodeWidth = node.width;
    const fills = (node as FrameNode | ComponentNode | InstanceNode).fills;
    const bgColorFill = 'fills' in node && Array.isArray(fills) ? (fills.find(f => f.type === 'SOLID' && f.visible) as SolidPaint) : undefined;
    const bgColor = bgColorFill ? this.getSolidHexForFill(bgColorFill, node) : undefined; // AJUSTADO
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
    
    let contentRowHtml = '';
    if (innerHtml.trim() !== '') {
        if (innerHtml.trim().startsWith('<tr')) {
            contentRowHtml = innerHtml;
        } else {
            contentRowHtml = `<tr><td>${innerHtml}</td></tr>`;
        }
    }
    
    const finalInnerHtml = `${paddingTopHtml}${contentRowHtml}${paddingBottomHtml}`;
    return `<table width="${Math.round(nodeWidth)}" border="0" cellpadding="0" cellspacing="0" style="${tableStyle}" ${tableBgColor}>${finalInnerHtml}</table>`;
  }
  
  private async renderStackedChildren(parentNode: FrameNode | GroupNode | ComponentNode | InstanceNode): Promise<string> {
    const children = [...parentNode.children].sort((a, b) => a.y - b.y);
    const rows: string[] = [];
    let lastBottomY = children.length > 0 ? children[0].y : 0;
    const paddingLeft = 'paddingLeft' in parentNode ? parentNode.paddingLeft : 0;
    const paddingRight = 'paddingRight' in parentNode ? parentNode.paddingRight : 0;
    for (const child of children) {
      if (!child.visible) continue;
      const verticalGap = child.y - lastBottomY;
      if (verticalGap > 2) {
        rows.push(`<tr><td height="${Math.round(verticalGap)}" style="font-size:1px; line-height:${Math.round(verticalGap)}px;">&nbsp;</td></tr>`);
      }
      const childHtml = await this.renderNode(child);
      if (childHtml.trim()){
        let paddingStyle = '';
        if (paddingLeft > 0) paddingStyle += `padding-left:${paddingLeft}px;`;
        if (paddingRight > 0) paddingStyle += `padding-right:${paddingRight}px;`;
        
        if (childHtml.trim().startsWith('<tr')) {
            rows.push(childHtml);
        } else {
            rows.push(`<tr><td style="${paddingStyle}" valign="top">${childHtml}</td></tr>`);
        }
      }
      lastBottomY = child.y + child.height;
    }
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
  
  private async renderStyledTextSegmentsToHtml(node: TextNode): Promise<string> {
    if (!node.characters || node.characters.length === 0) return '';
    const segments = node.getStyledTextSegments(['fontName', 'fontSize', 'fills', 'lineHeight', 'textDecoration']);
    let htmlContent = '';
    
    for (const segment of segments) {
      await figma.loadFontAsync(segment.fontName);
      const styles: string[] = [];
      const { family, style } = segment.fontName;
      const { fills, fontSize, lineHeight, textDecoration } = segment;

      if (Array.isArray(fills) && fills.length > 0 && fills[0].type === 'SOLID') {
        const solidFill = fills[0] as SolidPaint;
        styles.push(`color: ${this.getSolidHexForFill(solidFill, node)}`); // AJUSTADO
      }
      
      const fontStack = [...new Set([family, 'Arial', 'sans-serif'])];
      styles.push(`font-family: ${fontStack.join(', ')}`);
      
      styles.push(`font-size: ${Math.round(fontSize)}px`);
      styles.push(`font-weight: ${style.toLowerCase().includes('bold') ? '700' : '400'}`);
      
      if (lineHeight && lineHeight.unit !== 'AUTO') {
        styles.push(`line-height: ${Math.round(lineHeight.value)}px`);
      }
      if (textDecoration === 'UNDERLINE') {
        styles.push('text-decoration: underline');
      }
      const content = segment.characters.replace(/\n/g, '<br />');
      const finalContent = bulletCharacterMap[content.trim()] || content;
      htmlContent += `<span style="${styles.join('; ')}">${finalContent}</span>`;
    }
    return htmlContent;
  }
  
  private async renderText(node: TextNode): Promise<string> {
    if (!node.characters || node.characters.length === 0) return '';
    
    const styleProperties: ("fontName" | "fontSize" | "fills" | "lineHeight" | "textDecoration")[] = ['fontName', 'fontSize', 'fills', 'lineHeight', 'textDecoration'];
    const segments = node.getStyledTextSegments(styleProperties);
    if (segments.length === 0) return '';

    type StyleSegment = typeof segments[0];

    const fontsToLoad = [...new Set(segments.map(s => s.fontName))];
    await Promise.all(fontsToLoad.map(font => figma.loadFontAsync(font as FontName)));

    const getStyleObject = (segment: StyleSegment, ownerNode: SceneNode): { [key: string]: string } => { // AJUSTADO
        const { family, style } = segment.fontName;
        const { fills, fontSize, lineHeight, textDecoration } = segment;
        const props: { [key: string]: string } = {};

        if (fills && Array.isArray(fills) && fills.length > 0 && fills[0].type === 'SOLID') {
            const solidFill = fills[0] as SolidPaint;
            props.color = this.getSolidHexForFill(solidFill, ownerNode); // AJUSTADO
        }
        const fontStack = [...new Set([family, 'Arial', 'sans-serif'])];
        props['font-family'] = fontStack.join(', ');
        props['font-size'] = `${Math.round(fontSize as number)}px`;
        props['font-weight'] = style.toLowerCase().includes('bold') ? '700' : '400';
        if (lineHeight && 'value' in lineHeight) {
            props['line-height'] = `${Math.round(lineHeight.value)}px`;
        }
        if (textDecoration === 'UNDERLINE') {
            props['text-decoration'] = 'underline';
        }
        return props;
    };

    const baseStyle = getStyleObject(segments[0], node); // AJUSTADO
    const tdStyles: { [key: string]: string } = { ...baseStyle };
    tdStyles['text-align'] = (node.textAlignHorizontal || 'LEFT').toLowerCase();
    
    const tdStyleString = Object.keys(tdStyles)
        .map(key => `${key}: ${tdStyles[key]}`)
        .join('; ');

    let innerHtml = '';
    for (const segment of segments) {
        const currentStyle = getStyleObject(segment, node); // AJUSTADO
        const overrideStyles: { [key: string]: string } = {};

        Object.keys(currentStyle).forEach(key => {
            if (currentStyle[key] !== baseStyle[key]) {
                overrideStyles[key] = currentStyle[key];
            }
        });

        const content = segment.characters.replace(/\n/g, '<br />');
        const finalContent = bulletCharacterMap[content.trim()] || content;

        if (Object.keys(overrideStyles).length > 0) {
            const overrideStyleString = Object.keys(overrideStyles)
                .map(key => `${key}: ${overrideStyles[key]}`)
                .join('; ');
            innerHtml += `<span style="${overrideStyleString}">${finalContent}</span>`;
        } else {
            innerHtml += finalContent;
        }
    }

    return `<table width="100%" border="0" cellpadding="0" cellspacing="0"><tr><td style="${tdStyleString}" valign="top">${innerHtml}</td></tr></table>`;
  }

  private renderShape(node: SceneNode): string {
    const { width, height } = node;
    const fills = (node as RectangleNode).fills;
    const fill = 'fills' in node && Array.isArray(fills) ? (fills.find(f => f.type === 'SOLID' && f.visible) as SolidPaint) : undefined;
    const bgColor = fill ? `bgcolor="${this.getSolidHexForFill(fill, node)}"` : ''; // AJUSTADO
    return `<table width="${Math.round(width)}" height="${Math.round(height)}" border="0" cellpadding="0" cellspacing="0"><tr><td ${bgColor} style="font-size:1px; line-height:1px;">&nbsp;</td></tr></table>`;
  }

  private renderImagePlaceholder(node: SceneNode): string {
    const { width, height } = node;
    const url = `https://placehold.co/${Math.round(width)}x${Math.round(height)}/EFEFEF/7F7F7F?text=${encodeURIComponent(node.name || `${Math.round(width)}x${Math.round(height)}`)}`;
    return `<img src="${url}" width="${Math.round(width)}" alt="${node.name}" style="display: block; border: 0; width: ${Math.round(width)}px; height: auto;" />`;
  }

  public async parse(nodes: readonly SceneNode[]): Promise<string> {
    if (nodes.length === 0) return '';
    let finalHtml = '';
    if (nodes.length === 1) {
      finalHtml = await this.renderNode(nodes[0]);
    } else {
      const sortedNodes = [...nodes].sort((a, b) => a.y - b.y);
      const rows: string[] = [];
      let lastBottomY = 0;
      for (let i = 0; i < sortedNodes.length; i++) {
        const node = sortedNodes[i];
        if (i > 0) {
          const gap = node.y - lastBottomY;
          if (gap > 2) {
            rows.push(`<tr><td height="${Math.round(gap)}" style="font-size:1px; line-height:${Math.round(gap)}px;">&nbsp;</td></tr>`);
          }
        }
        const nodeHtml = await this.renderNode(node);
        if (nodeHtml.trim().startsWith('<tr')) {
            rows.push(nodeHtml);
        } else if (nodeHtml.trim()) {
            rows.push(`<tr><td>${nodeHtml}</td></tr>`);
        }
        if (node.visible) {
            lastBottomY = node.y + node.height;
        }
      }
      finalHtml = `<table width="100%" border="0" cellpadding="0" cellspacing="0">${rows.join('')}</table>`;
    }
    return finalHtml.replace(/<\/?tbody>/g, '').replace(/<tr[^>]*>\s*<td[^>]*>\s*<\/td>\s*<\/tr>/g, '').replace(/<tr[^>]*>\s*<\/tr>/g, '');
  }
}

type PluginMessage =
  | { type: 'generate-html-for-selection' }
  | { type: 'cta-confirmations-response'; payload: { confirmedCtaIds: string[] } };

figma.showUI(__html__, { width: 400, height: 450 });

const processSelection = async (confirmedCtaIds: string[] = []) => {
  const selectedNodes = figma.currentPage.selection;
  if (selectedNodes.length === 0) {
    figma.notify("Por favor, selecione pelo menos um elemento.");
    figma.ui.postMessage({ type: 'generated-html', payload: '' });
    return;
  }
  const parser = new FigmaPluginParser();
  parser.setConfirmedCtaIds(confirmedCtaIds);
  const html = await parser.parse(selectedNodes);
  figma.ui.postMessage({ type: 'generated-html', payload: html });
};

figma.ui.onmessage = async (msg: PluginMessage) => {
  if (msg.type === 'generate-html-for-selection') {
    const selectedNodes = figma.currentPage.selection;
    const allNodes = selectedNodes.reduce<SceneNode[]>((acc, node) => {
      const children = (node.type === 'FRAME' || node.type === 'GROUP' || node.type === 'COMPONENT' || node.type === 'INSTANCE') ? node.findAll(() => true) : [];
      return acc.concat(node, ...children);
    }, []);
    const potentialCtas = allNodes.filter(isPotentialCta);
    if (potentialCtas.length > 0) {
      figma.ui.postMessage({
        type: 'request-cta-confirmations',
        payload: potentialCtas.map(n => ({ id: n.id, name: n.name }))
      });
    } else {
      await processSelection();
    }
  }
  if (msg.type === 'cta-confirmations-response') {
    await processSelection(msg.payload.confirmedCtaIds);
  }
};
