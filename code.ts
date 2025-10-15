const bulletCharacterMap: { [key: string]: string } = {
  "•": "&#8226;",
  "*": "&#8226;",
  "-": "&#8211;",
};

type RgbColor = { r: number; g: number; b: number };
type RgbaColor = { r: number; g: number; b: number; a: number };

function figmaColorToHex(color: RgbColor): string {
  const toHex = (c: number) => ("0" + Math.round(c * 255).toString(16)).slice(-2);
  return `#${toHex(color.r)}${toHex(color.g)}${toHex(color.b)}`;
}

function findParentBackgroundColor(node: SceneNode): RgbColor {
  let parent = node.parent;
  while (parent && parent.type !== "PAGE") {
    if (
      "fills" in parent &&
      Array.isArray(parent.fills) &&
      parent.fills.length > 0
    ) {
      const solidFill = parent.fills.find(
        (f) => f.type === "SOLID" && f.visible !== false
      ) as SolidPaint;
      if (solidFill && (solidFill.opacity ?? 1) >= 0.99) {
        return solidFill.color;
      }
    }
    parent = parent.parent;
  }
  return { r: 1, g: 1, b: 1 };
}

class FigmaPluginParser {
  private confirmedCtaIds: Set<string> = new Set();

  public setConfirmedCtaIds(ids: string[]) {
    this.confirmedCtaIds = new Set(ids);
  }

  private sanitizeStyles(styleStr: string): string {
    if (!styleStr) return "";
    const styleMap = new Map<string, string>();
    styleStr
      .split(";")
      .filter((rule) => rule.trim())
      .forEach((rule) => {
        const [key, ...valueParts] = rule.split(":");
        const value = valueParts.join(":").trim();
        if (!key || !value) return;
        const prop = key.trim();
        if (prop === "font-family") {
          const fonts = value.split(",").map((f) => f.trim().replace(/'/g, ""));
          styleMap.set(prop, [...new Set(fonts)].join(", "));
        } else {
          styleMap.set(prop, value);
        }
      });
    return Array.from(styleMap.entries())
      .map(([k, v]) => `${k}:${v}`)
      .join(";");
  }

  private cleanZeroValueStyles(styleStr: string): string {
    if (!styleStr) return "";
    const filteredRules = styleStr.split(";").filter((rule) => {
      if (!rule.trim()) return false;
      const parts = rule.split(":");
      if (parts.length < 2) return true;
      const value = parts[1].trim();
      const isZeroLength = /^0(px|pt|em|rem|%|vw|vh)?$/.test(value);
      const key = parts[0].trim();
      if (
        ["margin", "padding", "border", "border-radius"].indexOf(key.split("-")[0]) !== -1 &&
        isZeroLength
      ) {
        return false;
      }
      return true;
    });
    return filteredRules.join(";");
  }

  private getBorderStyles(node: SceneNode): string | null {
    if (
      !("strokes" in node) || !Array.isArray(node.strokes) || node.strokes.length === 0 ||
      !("strokeWeight" in node) || typeof node.strokeWeight !== 'number' || node.strokeWeight === 0
    ) {
      return null;
    }
    const stroke = node.strokes.find(
      (s) => s.visible !== false && s.type === "SOLID"
    ) as SolidPaint | undefined;
    if (!stroke || !stroke.color) {
      return null;
    }
    const weight = Math.round(node.strokeWeight);
    if (weight === 0) return null;

    const parentBg = findParentBackgroundColor(node);
    const { hex: colorHex } = this.getEffectiveBackgroundColorForFills([stroke], parentBg);

    return `border: ${weight}px solid ${colorHex || '#000000'};`;
  }

  private blendColors(fg: RgbaColor, bg: RgbColor): RgbColor {
    const r = fg.r * fg.a + bg.r * (1 - fg.a);
    const g = fg.g * fg.a + bg.g * (1 - fg.a);
    const b = fg.b * fg.a + bg.b * (1 - fg.a);
    return { r, g, b };
  }

  private getEffectiveBackgroundColorForFills(fills: readonly Paint[], parentBgColor: RgbColor): { hex: string | null; rgb: RgbColor } {
      if (!Array.isArray(fills)) {
        return { hex: null, rgb: parentBgColor };
      }
      const fill = fills.find((f) => f.type === "SOLID" && f.visible !== false) as SolidPaint | undefined;

      if (!fill?.color) {
          return { hex: null, rgb: parentBgColor };
      }

      const fillOpacity = fill.opacity ?? 1;
      const totalOpacity = fillOpacity;

      if (totalOpacity >= 0.99) {
          const solidRgb = { r: fill.color.r, g: fill.color.g, b: fill.color.b };
          return { hex: figmaColorToHex(solidRgb), rgb: solidRgb };
      }

      const foregroundColor: RgbaColor = { r: fill.color.r, g: fill.color.g, b: fill.color.b, a: totalOpacity };
      const finalRgb = this.blendColors(foregroundColor, parentBgColor);

      return { hex: figmaColorToHex(finalRgb), rgb: finalRgb };
  }

  private getEffectiveBackgroundColor(node: SceneNode, parentBgColor: RgbColor): { hex: string | null; rgb: RgbColor } {
    const fills = 'fills' in node ? node.fills : [];
    if (fills && fills !== figma.mixed) {
        return this.getEffectiveBackgroundColorForFills(fills as readonly Paint[], parentBgColor);
    }
    return { hex: null, rgb: parentBgColor };
  }

  private isIconGroup(node: SceneNode): boolean {
    if (!("children" in node) || !node.children || node.children.length === 0)
      return false;
    const isVectorial = (n: SceneNode): boolean => {
      if (!("children" in n) || n.children.length === 0)
        return ["VECTOR", "ELLIPSE", "LINE", "RECTANGLE"].indexOf(n.type) !== -1;
      return n.children.every(
        (child) => child.type !== "TEXT" && isVectorial(child)
      );
    };
    return isVectorial(node);
  }

  private isImageLikeNode(node: SceneNode): boolean {
    if (
      node.type === "RECTANGLE" &&
      "fills" in node &&
      Array.isArray(node.fills) &&
      node.fills.some((f: any) => f.type === "IMAGE")
    ) {
      return true;
    }
    return ["VECTOR", "LINE"].indexOf(node.type) !== -1 || this.isIconGroup(node);
  }

  private async renderNode(
    node: SceneNode,
    parentWidth: number,
    parentBgColor: RgbColor
  ): Promise<string> {
    if (!node.visible) return "";

    switch (node.type) {
      case "FRAME":
      case "GROUP":
      case "COMPONENT":
      case "INSTANCE":
        if (this.isIconGroup(node)) {
          return this.renderImagePlaceholder(node, parentWidth);
        }
        if (isBulletPoint(node)) {
          return this.renderBulletPoint(node, parentWidth, parentBgColor);
        }
        if (this.confirmedCtaIds.has(node.id) && isPotentialCta(node)) {
          return this.renderCta(node, parentBgColor);
        }
        return this.renderContainer(node, parentWidth, parentBgColor);

      case "RECTANGLE":
      case "ELLIPSE":
        const hasImageFill = 'fills' in node && Array.isArray(node.fills) && node.fills.some((f: any) => f.type === "IMAGE");
        if (hasImageFill) {
            return this.renderImagePlaceholder(node, parentWidth);
        }
        return this.renderShape(node, parentWidth, parentBgColor);

      case "TEXT":
        return this.renderText(node, parentBgColor);

      case "VECTOR":
      case "LINE":
        return this.renderImagePlaceholder(node, parentWidth);

      default:
        return "";
    }
  }

  private async renderCta(node: FrameNode | GroupNode, parentBgColor: RgbColor): Promise<string> {
    const shapeNode = node.children.find(n => n.type === 'RECTANGLE' || n.type === 'ELLIPSE') as SceneNode & { cornerRadius?: any };
    const textNode = node.children.find(n => n.type === 'TEXT') as TextNode;
    
    const fontName = textNode.fontName;
    const fontSize = textNode.fontSize;
    if (fontName === figma.mixed || fontSize === figma.mixed) {
        return ``;
    }
    
    const { hex: bgColor } = this.getEffectiveBackgroundColor(shapeNode, parentBgColor);
    const finalBgColor = bgColor || '#6D28D9';
    
    const borderRadius = 'cornerRadius' in shapeNode && typeof shapeNode.cornerRadius === 'number' ? shapeNode.cornerRadius : 6;

    await figma.loadFontAsync(fontName);
    const { hex: textColor } = this.getEffectiveBackgroundColor(textNode, {r: 0, g: 0, b: 0});
    const finalTextColor = textColor || '#FFFFFF';

    const { family, style } = fontName;
    const fontWeight = style.toLowerCase().indexOf('bold') !== -1 ? '700' : '400';
    const finalFontSize = Math.round(fontSize);
    const href = '#';

    return `<table border="0" cellpadding="0" cellspacing="0" role="presentation"><tr><td align="center" style="border-radius: ${borderRadius}px; background-color: ${finalBgColor};" bgcolor="${finalBgColor}"><a href="${href}" target="_blank" style="font-family: '${family}', Arial, sans-serif; font-size: ${finalFontSize}px; font-weight: ${fontWeight}; color: ${finalTextColor}; text-decoration: none; padding: 12px 24px; border-radius: ${borderRadius}px; display: inline-block;">${textNode.characters}</a></td></tr></table>`;
  }

  private async renderStackedChildren(
    parentNode: FrameNode | GroupNode | ComponentNode | InstanceNode,
    parentWidth: number,
    parentBgColor: RgbColor
  ): Promise<string> {
    const children = ("children" in parentNode ? [...parentNode.children] : []).filter(c => c.visible);
    if ('layoutMode' in parentNode && parentNode.layoutMode !== 'VERTICAL') {
      children.sort((a,b) => a.y - b.y);
    }
    
    const rows: string[] = [];
    let lastBottomY = ('paddingTop' in parentNode && typeof parentNode.paddingTop === 'number' ? parentNode.paddingTop : 0);

    const paddingLeft = 'paddingLeft' in parentNode && typeof parentNode.paddingLeft === 'number' ? Math.round(parentNode.paddingLeft) : 0;
    const paddingRight = 'paddingRight' in parentNode && typeof parentNode.paddingRight === 'number' ? Math.round(parentNode.paddingRight) : 0;
    const availableWidth = parentWidth - paddingLeft - paddingRight;

    for(const child of children) {
      const verticalGap = Math.round(child.y - lastBottomY);
      if (verticalGap > 2) {
        rows.push(
          `<tr><td height="${verticalGap}" style="font-size:${verticalGap}px; line-height:${verticalGap}px;" colspan="3">&nbsp;</td></tr>`
        );
      }

      const childHtml = await this.renderNode(
        child,
        availableWidth,
        parentBgColor
      );

      if (childHtml) {
        const leftSpacerCell =
          paddingLeft > 0
            ? `<td class="gutter" width="${paddingLeft}">&nbsp;</td>`
            : "";
        const contentCellHtml = `<td>${childHtml}</td>`;
        const rightSpacerCell =
          paddingRight > 0
            ? `<td class="gutter" width="${paddingRight}">&nbsp;</td>`
            : "";
        rows.push(
          `<tr>${leftSpacerCell}${contentCellHtml}${rightSpacerCell}</tr>`
        );
      }

      lastBottomY = child.y + child.height;
    }

    return `<table width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation">${rows.join('')}</table>`;
  }

  private async renderContainer(
    node: FrameNode | GroupNode | ComponentNode | InstanceNode,
    parentWidth: number,
    parentBgColor: RgbColor,
    isRoot: boolean = false,
  ): Promise<string> {
    const children = ("children" in node ? node.children : []).filter(
      (c) => c.visible !== false
    );
    const { hex: bgColorHex, rgb: effectiveBgRgb } =
      this.getEffectiveBackgroundColor(node, parentBgColor);

    if (children.length === 0 && !bgColorHex && !this.getBorderStyles(node)) {
      return "";
    }
    
    const nodeWidth = Math.round(node.width);
    const finalWidth = isRoot ? 600 : Math.min(nodeWidth, parentWidth);

    const isFluid = !isRoot && (nodeWidth / parentWidth > 0.95 || nodeWidth > 450);

    const tableStyles = this.sanitizeStyles(
      this.cleanZeroValueStyles(
        [
          bgColorHex ? `background-color:${bgColorHex}` : null,
          this.getBorderStyles(node),
        ]
          .filter(Boolean)
          .join(";")
      )
    );

    const tableStyleAttr = tableStyles ? `style="${tableStyles}"` : "";
    const tableBgColorAttr = bgColorHex ? `bgcolor="${bgColorHex}"` : "";
    const tableWidthAttr = isRoot ? `width="${finalWidth}"` : isFluid ? 'width="100%"' : `width="${finalWidth}"`;
    const className = isRoot ? 'class="wrapper"' : "";

    let innerHtml: string;
    const layoutMode = 'layoutMode' in node ? node.layoutMode : 'NONE';
    
    if (layoutMode === "HORIZONTAL") {
      innerHtml = await this.renderHorizontalChildren(
        node as FrameNode,
        finalWidth,
        effectiveBgRgb
      );
    } else {
      innerHtml = await this.renderStackedChildren(
        node,
        finalWidth,
        effectiveBgRgb
      );
    }

    const paddingTop = 'paddingTop' in node && typeof node.paddingTop === 'number' ? Math.round(node.paddingTop) : 0;
    const paddingBottom = 'paddingBottom' in node && typeof node.paddingBottom === 'number' ? Math.round(node.paddingBottom) : 0;
    
    const paddingTopHtml =
      paddingTop > 0
        ? `<tr><td height="${paddingTop}" style="font-size:${paddingTop}px; line-height:${paddingTop}px;">&nbsp;</td></tr>`
        : "";
    const paddingBottomHtml =
      paddingBottom > 0
        ? `<tr><td height="${paddingBottom}" style="font-size:${paddingBottom}px; line-height:${paddingBottom}px;">&nbsp;</td></tr>`
        : "";

    const finalInnerHtml = `
      ${paddingTopHtml}
      ${innerHtml ? `<tr><td>${innerHtml}</td></tr>` : ''} 
      ${paddingBottomHtml}
    `;

    return `<table ${className} ${tableWidthAttr} ${tableBgColorAttr} ${tableStyleAttr} cellpadding="0" cellspacing="0" border="0" role="presentation">${finalInnerHtml}</table>`;
  }
    
  private async renderHorizontalChildren(
    node: FrameNode,
    parentWidth: number,
    parentBgColor: RgbColor
  ): Promise<string> {
    const children = (node.children || []).filter(
      (c) => c.visible !== false
    );
    const itemSpacing = typeof node.itemSpacing === 'number' ? Math.round(node.itemSpacing) : 0;
    const totalChildWidth = children.reduce(
      (sum, c) => sum + c.width,
      0
    );
    const totalSpacing = itemSpacing * (children.length - 1);
    const totalContentWidth = totalChildWidth + totalSpacing;

    let cells: string[] = [];

    for(const [index, child] of children.entries()) {
      const colWidth = Math.round(child.width);
      let widthAttr = "";

      if (this.isImageLikeNode(child)) {
        widthAttr = `width="${colWidth}"`;
      } else if (
        ["FRAME", "GROUP", "INSTANCE", "COMPONENT"].indexOf(child.type) !== -1 &&
        children.length > 1
      ) {
        const percentage = ((colWidth / totalContentWidth) * 100).toFixed(2);
        widthAttr = `width="${percentage}%"`;
      }

      const childHtml = await this.renderNode(
        child,
        colWidth,
        parentBgColor
      );

      const finalWidthAttr = widthAttr ? ` ${widthAttr}` : "";
      cells.push(`<td${finalWidthAttr} valign="top">${childHtml}</td>`);

      if (index < children.length - 1 && itemSpacing > 0) {
        cells.push(`<td width="${itemSpacing}" style="font-size:0; line-height:0;">&nbsp;</td>`);
      }
    }

    return `<table width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation"><tr>${cells.join('')}</tr></table>`;
  }

  private async renderText(node: TextNode, parentBgColor: RgbColor): Promise<string> {
    if (!node.characters?.trim()) return "";
    
    const textAlign = (node.textAlignHorizontal || 'LEFT').toLowerCase();
    let alignAttr = (textAlign !== 'left') ? `align="${textAlign}"` : '';

    const segments = node.getStyledTextSegments(['fontName', 'fontSize', 'fills', 'lineHeight', 'textDecoration']);
    
    if (segments.length === 1) {
        const segment = segments[0];
        if (typeof segment.fontName === "symbol" && segment.fontName === figma.mixed) return "";
        await figma.loadFontAsync(segment.fontName);
        const styleCss = this.styleObjectToInlineCss(segment, parentBgColor);
        const borderStyles = this.getBorderStyles(node);
        const textAlignStyle = `text-align: ${textAlign};`;
        const allStyles = this.sanitizeStyles(
            [textAlignStyle, styleCss, borderStyles].filter(Boolean).join(";")
        );
        const styleAttr = allStyles ? `style="${allStyles}"` : "";
        const sanitizedChars = node.characters
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/\n/g, "<br />");
        return `<table cellpadding="0" cellspacing="0" border="0" role="presentation" width="100%"><tr><td ${alignAttr} ${styleAttr}>${sanitizedChars}</td></tr></table>`;
    }

    const contentHtml = await this.renderTextContent(node, parentBgColor);
    if (!contentHtml) return "";

    const containerStyles = this.sanitizeStyles(this.cleanZeroValueStyles(
        [this.getBorderStyles(node)].filter(Boolean).join(";")
    ));

    const textAlignStyle = `text-align: ${textAlign};`;
    const finalTdStyle = containerStyles ? `${containerStyles};${textAlignStyle}` : textAlignStyle;
    const styleAttr = finalTdStyle ? `style="${finalTdStyle}"` : "";

    return `<table cellpadding="0" cellspacing="0" border="0" role="presentation" width="100%"><tr><td ${alignAttr} ${styleAttr}>${contentHtml}</td></tr></table>`;
  }

  private async renderTextContent(node: TextNode, parentBgColor: RgbColor): Promise<string> {
    if (!node.characters?.trim()) return "";

    let htmlOutput = "";
    const segments = node.getStyledTextSegments(['fontName', 'fontSize', 'fills', 'lineHeight', 'textDecoration']);
    
    for (const segment of segments) {
        if (typeof segment.fontName === "symbol" && segment.fontName === figma.mixed) continue;
        await figma.loadFontAsync(segment.fontName);
        const styleCss = this.styleObjectToInlineCss(segment, parentBgColor);
        const sanitizedChars = segment.characters
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/\n/g, "<br />");
        
        const finalContent = bulletCharacterMap[sanitizedChars.trim()] || sanitizedChars;

        if (styleCss) {
            htmlOutput += `<span style="${styleCss}">${finalContent}</span>`;
        } else {
            htmlOutput += finalContent;
        }
    }
    
    return htmlOutput;
  }
  
  private styleObjectToInlineCss(style: any, parentBgColor: RgbColor): string {
    const styles: string[] = [];
    if (!style) return "";

    if (style.fills && style.fills.length > 0) {
        const { hex: colorHex } = this.getEffectiveBackgroundColorForFills(style.fills, parentBgColor);
        if(colorHex) styles.push(`color: ${colorHex}`);
    }

    if (style.fontName && style.fontName !== figma.mixed) {
      styles.push(`font-family: '${style.fontName.family}', sans-serif`);
      if (style.fontName.style.toLowerCase().indexOf('bold') !== -1) {
          styles.push(`font-weight: 700`);
      }
    }
    if (style.fontSize && style.fontSize !== figma.mixed) {
      styles.push(`font-size: ${Math.round(style.fontSize)}px`);
    }
    if (style.lineHeight && style.lineHeight.unit !== 'AUTO') {
        if(style.lineHeight.unit === 'PIXELS') {
            styles.push(`line-height: ${Math.round(style.lineHeight.value)}px`);
        } else if (style.lineHeight.unit === 'PERCENT') {
            styles.push(`line-height: ${Math.round(style.lineHeight.value)}%`);
        }
    }
    if (style.textDecoration === "STRIKETHROUGH") {
      styles.push("text-decoration: line-through");
    } else if (style.textDecoration === "UNDERLINE") {
      styles.push("text-decoration: underline");
    }

    return this.sanitizeStyles(this.cleanZeroValueStyles(styles.join(";")));
  }
  
  private async renderBulletPoint(node: FrameNode, parentWidth: number, parentBgColor: RgbColor): Promise<string> {
    const bulletNode = node.children[0] as TextNode;
    const textNode = node.children[1] as TextNode;
    const itemSpacing = typeof node.itemSpacing === 'number' ? node.itemSpacing : 8;
    
    const bulletHtml = await this.renderTextContent(bulletNode, parentBgColor);
    const textHtml = await this.renderTextContent(textNode, parentBgColor);

    return `<table width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation"><tr><td style="width:1%;" valign="top">${bulletHtml}</td><td width="${itemSpacing}">&nbsp;</td><td valign="top">${textHtml}</td></tr></table>`;
  }

  private renderShape(
    node: SceneNode,
    parentWidth: number,
    parentBgColor: RgbColor
  ): string {
    const { width = 0, height = 0 } = node;
    if (width < 1 || height < 1) return "";
    
    const { hex: bgColorHex } = this.getEffectiveBackgroundColor(
      node,
      parentBgColor
    );
    
    const finalHeight = Math.round(height);

    const cellStyles = this.sanitizeStyles(
      this.cleanZeroValueStyles(
        [
          bgColorHex ? `background-color:${bgColorHex}` : null,
          `height:${finalHeight}px;`,
          `font-size:1px;`,
          `line-height:1px;`,
          this.getBorderStyles(node),
        ]
          .filter(Boolean)
          .join(";")
      )
    );

    const bgColorAttr = bgColorHex ? `bgcolor="${bgColorHex}"` : "";
    const styleAttr = cellStyles ? `style="${cellStyles}"` : "";

    return `<table width="100%" height="${finalHeight}" cellpadding="0" cellspacing="0" border="0" role="presentation"><tr><td ${bgColorAttr} ${styleAttr}>&nbsp;</td></tr></table>`;
  }

  private renderImagePlaceholder(
    node: SceneNode,
    parentWidth: number
  ): string {
    const { width, height } = node;
    if (width < 1 || height < 1) return "";
    const w = Math.round(width);
    const h = Math.round(height);
    const finalWidth = Math.max(1, Math.min(w, parentWidth));
    const url = `https://placehold.co/${finalWidth}x${h}/EFEFEF/7F7F7F?text=${encodeURIComponent(
      `${finalWidth} x ${h}`
    )}`;
    return `<img src="${url}" width="${finalWidth}" alt="${
      node.name || "Image"
    }" style="display: block; border: 0; width: 100%; max-width: ${finalWidth}px; height: auto;" />`;
  }

  public async parse(nodes: readonly SceneNode[], isRoot: boolean = true): Promise<string> {
    if (nodes.length === 0) return "";
    
    const rootBgColor = { r: 1, g: 1, b: 1 };
    
    let finalHtml = '';
    if (nodes.length === 1) {
        const node = nodes[0];
        if (node.type === "FRAME" || node.type === "COMPONENT" || node.type === "INSTANCE") {
            finalHtml = await this.renderContainer(node, node.width, rootBgColor, true);
        } else {
            finalHtml = await this.renderNode(node, node.width, rootBgColor);
        }
    } else {
      const sortedNodes = [...nodes].sort((a, b) => a.y - b.y);
      const rows: string[] = [];
      let lastBottomY = 0;
      for (let i = 0; i < sortedNodes.length; i++) {
        const node = sortedNodes[i];
        if (i > 0) {
          const gap = Math.round(node.y - lastBottomY);
          if (gap > 2) {
            rows.push(`<tr><td height="${gap}" style="font-size:${gap}px; line-height:${gap}px;">&nbsp;</td></tr>`);
          }
        }
        const nodeHtml = await this.renderNode(node, node.width, rootBgColor);
        if (nodeHtml.trim()) {
          rows.push(`<tr><td>${nodeHtml}</td></tr>`);
        }
        if (node.visible) {
          lastBottomY = node.y + node.height;
        }
      }
      finalHtml = `<table width="600" border="0" cellpadding="0" cellspacing="0" role="presentation" align="center" style="width:600px;">${rows.join('')}</table>`;
    }
    return finalHtml.replace(/<\/?tbody>/g, '').replace(/<tr[^>]*>\s*<td[^>]*>\s*<\/td>\s*<\/tr>/g, '').replace(/<tr[^>]*>\s*<\/tr>/g, '');
  }
}

function isPotentialCta(node: SceneNode): node is FrameNode | GroupNode {
  if (node.type !== 'FRAME' && node.type !== 'GROUP') return false;
  if (!("children" in node)) return false;
  if (node.children.length !== 2) return false;
  const hasText = node.children.some(child => child.type === 'TEXT');
  const hasShape = node.children.some(child => child.type === 'RECTANGLE' || child.type === 'ELLIPSE');
  return hasText && hasShape;
}

function isBulletPoint(node: SceneNode): node is FrameNode {
  if (node.type !== 'FRAME' || !node.visible) {
    return false;
  }
  if (node.layoutMode !== 'HORIZONTAL' || !("children" in node) || node.children.length !== 2) {
    return false;
  }
  const [firstChild, secondChild] = node.children;
  if (firstChild.type !== 'TEXT' || secondChild.type !== 'TEXT') {
    return false;
  }
  const bulletChar = firstChild.characters.trim();
  return bulletChar.length === 1 && bulletChar in bulletCharacterMap;
}

type PluginMessage =
  | { type: 'generate-html-for-selection' }
  | { type: 'cta-confirmations-response'; payload: { confirmedCtaIds: string[] } };

figma.showUI(__html__, { width: 400, height: 450 });

const processSelection = async (confirmedCtaIds: string[] = []) => {
  const selectedNodes = figma.currentPage.selection;
  if (selectedNodes.length === 0) {
    figma.notify("Please select at least one element.");
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
      const children = (node.type === 'FRAME' || node.type === 'GROUP' || node.type === 'COMPONENT' || node.type === 'INSTANCE') && 'findAll' in node ? node.findAll(() => true) : [];
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