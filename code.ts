const bulletCharacterMap: { [key: string]: string } = {
  "•": "&#8226;",
  "*": "&#8226;",
  "-": "&#8211;",
};

type RgbColor = { r: number; g: number; b: number };
type RgbaColor = { r: number; g: number; b: number; a: number };
type ImageExportMode = 'placeholder' | 'base64' | 'download';
type ImageAsset = {
  name: string;
  data: Uint8Array;
};

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
        (f) => (f.type === "SOLID" || f.type.startsWith("GRADIENT")) && f.visible !== false
      ) as SolidPaint | GradientPaint;
        
      if (solidFill) {
          if (solidFill.type === 'SOLID') {
              if ((solidFill.opacity ?? 1) >= 0.99) {
                  return solidFill.color;
              }
          } else {
              const firstStop = solidFill.gradientStops[0];
              if ((firstStop.color.a ?? 1) >= 0.99) {
                 return { r: firstStop.color.r, g: firstStop.color.g, b: firstStop.color.b };
              }
          }
      }
    }
    parent = parent.parent;
  }
  return { r: 1, g: 1, b: 1 };
}

async function collectAndLoadAllFonts(nodes: readonly SceneNode[]) {
    const fontNames = new Set<FontName>();
    function findFonts(node: SceneNode) {
        if (node.type === 'TEXT' && node.fontName !== figma.mixed) {
            fontNames.add(node.fontName as FontName);
        }
        if ("children" in node) {
            for (const child of node.children) {
                findFonts(child);
            }
        }
    }
    for (const node of nodes) {
        findFonts(node);
    }
    if (fontNames.size > 0) {
        await Promise.all(Array.from(fontNames).map(font => figma.loadFontAsync(font)));
    }
}

class FigmaPluginParser {
  private imageAssets: ImageAsset[] = [];
  private imageCounter = 0;

  public getCollectedImageAssets(): ImageAsset[] {
    return this.imageAssets;
  }

  private sanitizeStyles(styleStr: string): string {
    if (!styleStr) return "";
    const styleMap = new Map<string, string>();
    styleStr.split(";").filter((rule) => rule.trim()).forEach((rule) => {
        const [key, ...valueParts] = rule.split(":");
        const value = valueParts.join(":").trim();
        if (!key || !value) return;
        const prop = key.trim();
        styleMap.set(prop, value);
    });
    return Array.from(styleMap.entries()).map(([k, v]) => `${k}:${v}`).join(";");
  }

  private cleanZeroValueStyles(styleStr: string): string {
    if (!styleStr) return "";
    return styleStr.split(";").filter((rule) => {
        if (!rule.trim()) return false;
        const [key, value] = rule.split(":").map(s => s.trim());
        if (!value) return true;
        const isZero = /^0(px|pt|em|%|vw|vh)?$/.test(value);
        if (key.includes("border-radius") || (key.startsWith("padding") || key.startsWith("margin") || key.startsWith("border")) && isZero) {
            return false;
        }
        return true;
    }).join(";");
  }

  private getBorderStyles(node: SceneNode): string | null {
    if (!("strokes" in node) || !Array.isArray(node.strokes) || node.strokes.length === 0 || !("strokeWeight" in node) || typeof node.strokeWeight !== 'number' || node.strokeWeight === 0) {
      return null;
    }
    const stroke = node.strokes.find((s) => s.visible !== false && s.type === "SOLID") as SolidPaint | undefined;
    if (!stroke || !stroke.color) return null;
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
    if (!Array.isArray(fills) || fills.length === 0) return { hex: null, rgb: parentBgColor };
    const visibleFill = fills.find((f) => f.visible !== false);
    if (!visibleFill) return { hex: null, rgb: parentBgColor };

    let color: RgbColor;
    let opacity = 1.0;

    if (visibleFill.type === "SOLID") {
      color = visibleFill.color;
      opacity = visibleFill.opacity ?? 1;
    } else if (visibleFill.type.startsWith("GRADIENT")) {
      color = visibleFill.gradientStops[0].color;
      opacity = visibleFill.gradientStops[0].color.a ?? 1;
    } else {
      return { hex: null, rgb: parentBgColor };
    }
    
    if (opacity >= 0.99) return { hex: figmaColorToHex(color), rgb: color };
    const finalRgb = this.blendColors({ ...color, a: opacity }, parentBgColor);
    return { hex: figmaColorToHex(finalRgb), rgb: finalRgb };
  }

  private getEffectiveBackgroundColor(node: SceneNode, parentBgColor: RgbColor): { hex: string | null; rgb: RgbColor } {
    const fills = 'fills' in node ? node.fills : [];
    if (fills && fills !== figma.mixed) {
      return this.getEffectiveBackgroundColorForFills(fills as readonly Paint[], parentBgColor);
    }
    return { hex: null, rgb: parentBgColor };
  }

  private isImageLikeNode(node: SceneNode): boolean {
    if ((node.type === "RECTANGLE" || node.type === "ELLIPSE") && "fills" in node && Array.isArray(node.fills) && node.fills.some((f: any) => f.type === "IMAGE")) return true;
    if (["VECTOR", "LINE"].indexOf(node.type) !== -1) return true;
    if ("children" in node && node.children.length > 0) {
      return node.children.every(child => child.type !== "TEXT" && this.isImageLikeNode(child));
    }
    return false;
  }

  private async renderNode(node: SceneNode, parentWidth: number, parentBgColor: RgbColor, imageExportMode: ImageExportMode): Promise<string> {
    if (!node.visible) return "";
    if (this.isImageLikeNode(node)) return this.renderImage(node, parentWidth, imageExportMode);

    switch (node.type) {
      case "FRAME":
      case "GROUP":
      case "COMPONENT":
      case "INSTANCE":
        if (isBulletPoint(node)) return this.renderBulletPoint(node, parentBgColor);
        return this.renderContainer(node, parentWidth, parentBgColor, false, imageExportMode);
      case "RECTANGLE":
      case "ELLIPSE":
        return this.renderShape(node, parentBgColor);
      case "TEXT":
        return this.renderText(node, parentBgColor);
      default:
        return "";
    }
  }

  private async renderStackedChildren(parentNode: FrameNode | GroupNode | ComponentNode | InstanceNode, parentWidth: number, parentBgColor: RgbColor, imageExportMode: ImageExportMode): Promise<string> {
    const children = ("children" in parentNode ? [...parentNode.children] : []).filter(c => c.visible);
    if ('layoutMode' in parentNode && parentNode.layoutMode !== 'VERTICAL') children.sort((a,b) => a.y - b.y);
    const rows: string[] = [];
    let lastBottomY = ('paddingTop' in parentNode ? parentNode.paddingTop : 0) as number;
    const paddingLeft = ('paddingLeft' in parentNode ? parentNode.paddingLeft : 0) as number;
    const paddingRight = ('paddingRight' in parentNode ? parentNode.paddingRight : 0) as number;
    const availableWidth = parentWidth - paddingLeft - paddingRight;

    for (const child of children) {
      const verticalGap = Math.round(child.y - lastBottomY);
      if (verticalGap > 2) rows.push(`<tr><td height="${verticalGap}" style="height:${verticalGap}px; font-size:${verticalGap}px; line-height:${verticalGap}px;" colspan="3">&nbsp;</td></tr>`);
      const childHtml = await this.renderNode(child, availableWidth, parentBgColor, imageExportMode);
      if (childHtml) {
        const leftSpacer = paddingLeft > 0 ? `<td class="gutter" width="${paddingLeft}" style="width: ${paddingLeft}px;">&nbsp;</td>` : "";
        const rightSpacer = paddingRight > 0 ? `<td class="gutter" width="${paddingRight}" style="width: ${paddingRight}px;">&nbsp;</td>` : "";
        rows.push(`<tr>${leftSpacer}<td>${childHtml}</td>${rightSpacer}</tr>`);
      }
      lastBottomY = child.y + child.height;
    }
    return `<table width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation">${rows.join('')}</table>`;
  }

  private async renderContainer(node: FrameNode | GroupNode | ComponentNode | InstanceNode, parentWidth: number, parentBgColor: RgbColor, isRoot: boolean, imageExportMode: ImageExportMode): Promise<string> {
    const { hex: bgColorHex, rgb: effectiveBgRgb } = this.getEffectiveBackgroundColor(node, parentBgColor);
    const children = "children" in node ? node.children.filter(c => c.visible) : [];
    if (children.length === 0 && !bgColorHex && !this.getBorderStyles(node)) return "";

    let innerHtml: string;
    const layoutMode = 'layoutMode' in node ? node.layoutMode : 'NONE';

    if (layoutMode === "HORIZONTAL") {
      innerHtml = await this.renderHorizontalChildren(node as FrameNode, parentWidth, effectiveBgRgb, imageExportMode);
    } else {
      innerHtml = await this.renderStackedChildren(node, parentWidth, effectiveBgRgb, imageExportMode);
    }

    const hasStyles = !!bgColorHex || !!this.getBorderStyles(node);
    const paddingTop = 'paddingTop' in node ? Math.round((node as any).paddingTop as number) : 0;
    const paddingBottom = 'paddingBottom' in node ? Math.round((node as any).paddingBottom as number) : 0;
    
    if (!hasStyles && paddingTop === 0 && paddingBottom === 0 && !isRoot) {
      return innerHtml;
    }

    const tableStyles = this.sanitizeStyles(this.cleanZeroValueStyles([bgColorHex ? `background-color:${bgColorHex}` : null, this.getBorderStyles(node)].filter(Boolean).join(";")));
    const paddingTopHtml = paddingTop > 0 ? `<tr><td height="${paddingTop}" style="font-size:${paddingTop}px; line-height:${paddingTop}px;">&nbsp;</td></tr>` : "";
    const paddingBottomHtml = paddingBottom > 0 ? `<tr><td height="${paddingBottom}" style="font-size:${paddingBottom}px; line-height:${paddingBottom}px;">&nbsp;</td></tr>` : "";
    const finalInnerHtml = `${paddingTopHtml}${innerHtml ? `<tr><td>${innerHtml}</td></tr>` : ''}${paddingBottomHtml}`;
    const width = isRoot ? parentWidth : Math.min(node.width, parentWidth);

    return `<table width="${width}" ${bgColorHex ? `bgcolor="${bgColorHex}"` : ''} ${tableStyles ? `style="${tableStyles}"` : ''} cellpadding="0" cellspacing="0" border="0" role="presentation">${finalInnerHtml}</table>`;
  }
    
  private async renderHorizontalChildren(node: FrameNode, parentWidth: number, parentBgColor: RgbColor, imageExportMode: ImageExportMode): Promise<string> {
    const children = (node.children || []).filter((c) => c.visible !== false);
    const itemSpacing = typeof node.itemSpacing === 'number' ? Math.round(node.itemSpacing) : 0;
    const cells: string[] = [];
    const isSpaceBetween = node.primaryAxisAlignItems === 'SPACE_BETWEEN' && children.length > 1;

    for (const [index, child] of children.entries()) {
      const childHtml = await this.renderNode(child, child.width, parentBgColor, imageExportMode);
      let valign = "top";
      if (node.counterAxisAlignItems === 'CENTER') valign = 'middle';
      if (node.counterAxisAlignItems === 'MAX') valign = 'bottom';
      cells.push(`<td valign="${valign}">${childHtml}</td>`);
      if (index < children.length - 1) {
        if (isSpaceBetween) cells.push(`<td width="100%">&nbsp;</td>`);
        else if (itemSpacing > 0) cells.push(`<td width="${itemSpacing}" style="width: ${itemSpacing}px;">&nbsp;</td>`);
      }
    }
    return `<table width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation"><tr>${cells.join('')}</tr></table>`;
  }

  private async renderText(node: TextNode, parentBgColor: RgbColor): Promise<string> {
    if (!node.characters?.trim()) return "";
    const textAlign = (node.textAlignHorizontal || 'LEFT').toLowerCase();
    const contentHtml = await this.renderTextContent(node, parentBgColor);
    const containerStyles = this.sanitizeStyles(this.cleanZeroValueStyles([this.getBorderStyles(node)].filter(Boolean).join(";")));
    const finalTdStyle = `${containerStyles ? `${containerStyles};` : ''}text-align: ${textAlign};`;
    return `<table cellpadding="0" cellspacing="0" border="0" width="100%"><tr><td align="${textAlign}" style="${finalTdStyle}">${contentHtml}</td></tr></table>`;
  }

  private async renderTextContent(node: TextNode, parentBgColor: RgbColor): Promise<string> {
    if (!node.characters?.trim()) return "";
    let htmlOutput = "";
    const segments = node.getStyledTextSegments(['fontName', 'fontSize', 'fills', 'lineHeight', 'textDecoration']);
    for (const segment of segments) {
      if (typeof segment.fontName === "symbol") continue;
      const styleCss = this.styleObjectToInlineCss(segment, parentBgColor);
      const sanitizedChars = segment.characters.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, "<br />");
      const finalContent = bulletCharacterMap[sanitizedChars.trim()] || sanitizedChars;
      htmlOutput += styleCss ? `<span style="${styleCss}">${finalContent}</span>` : finalContent;
    }
    return htmlOutput;
  }
  
  private styleObjectToInlineCss(style: any, parentBgColor: RgbColor): string {
    const styles: string[] = [];
    if (style.fills && style.fills.length > 0) {
      const { hex: colorHex } = this.getEffectiveBackgroundColorForFills(style.fills, parentBgColor);
      if (colorHex) styles.push(`color: ${colorHex}`);
    }
    if (style.fontName?.family) {
      styles.push(`font-family: '${style.fontName.family}', sans-serif`);
      if (style.fontName.style.toLowerCase().includes('bold')) styles.push(`font-weight: 700`);
    }
    if (style.fontSize) styles.push(`font-size: ${Math.round(style.fontSize)}px`);
    if (style.lineHeight?.unit !== 'AUTO') {
      if (style.lineHeight.unit === 'PIXELS') styles.push(`line-height: ${Math.round(style.lineHeight.value)}px`);
      else if (style.lineHeight.unit === 'PERCENT') styles.push(`line-height: ${Math.round(style.lineHeight.value)}%`);
    }
    if (style.textDecoration === "UNDERLINE") styles.push("text-decoration: underline");
    return this.sanitizeStyles(this.cleanZeroValueStyles(styles.join(";")));
  }
  
  private async renderBulletPoint(node: FrameNode, parentBgColor: RgbColor): Promise<string> {
    const bulletNode = node.children[0] as TextNode;
    const textNode = node.children[1] as TextNode;
    const itemSpacing = typeof node.itemSpacing === 'number' ? node.itemSpacing : 8;
    const bulletHtml = await this.renderTextContent(bulletNode, parentBgColor);
    const textHtml = await this.renderTextContent(textNode, parentBgColor);
    return `<table width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation"><tr><td style="width:1%;" valign="top">${bulletHtml}</td><td width="${itemSpacing}" style="width: ${itemSpacing}px;">&nbsp;</td><td valign="top">${textHtml}</td></tr></table>`;
  }

  private renderShape(node: SceneNode, parentBgColor: RgbColor): string {
    const { width = 0, height = 0 } = node;
    if (width < 1 || height < 1) return "";
    const { hex: bgColorHex } = this.getEffectiveBackgroundColor(node, parentBgColor);
    const finalHeight = Math.round(height);
    const cellStyles = this.sanitizeStyles(this.cleanZeroValueStyles([bgColorHex ? `background-color:${bgColorHex}` : null, `height:${finalHeight}px;`, `font-size:1px;`, `line-height:1px;`, this.getBorderStyles(node)].filter(Boolean).join(";")));
    return `<table width="100%" height="${finalHeight}" cellpadding="0" cellspacing="0" border="0"><tr><td ${bgColorHex ? `bgcolor="${bgColorHex}"` : ''} ${cellStyles ? `style="${cellStyles}"` : ''}>&nbsp;</td></tr></table>`;
  }

  private async renderImage(node: SceneNode, parentWidth: number, mode: ImageExportMode): Promise<string> {
    const { width, height } = node;
    if (width < 1 || height < 1) return "";
    const finalWidth = Math.min(Math.round(width), parentWidth);
    const altText = node.name || 'Image';

    if (mode === 'placeholder') {
      const url = `https://placehold.co/${finalWidth}x${Math.round(height)}/EFEFEF/7F7F7F?text=${finalWidth}x${Math.round(height)}`;
      return `<img src="${url}" width="${finalWidth}" alt="${altText}" style="display: block; border: 0; width: 100%; max-width: ${finalWidth}px; height: auto;" />`;
    }
    
    try {
      const exportSettings: ExportSettingsImage = { format: 'PNG', constraint: { type: 'WIDTH', value: Math.round(width * 2) } };
      const imageBytes = await node.exportAsync(exportSettings);
      
      if (mode === 'base64') {
        const base64String = figma.base64Encode(imageBytes);
        return `<img src="data:image/png;base64,${base64String}" width="${finalWidth}" alt="${altText}" style="display: block; border: 0; width: 100%; max-width: ${finalWidth}px; height: auto;" />`;
      }

      if (mode === 'download') {
        this.imageCounter++;
        const imageName = `image-${this.imageCounter}.png`;
        this.imageAssets.push({ name: imageName, data: imageBytes });
        return `<img src="images/${imageName}" width="${finalWidth}" alt="${altText}" style="display: block; border: 0; width: 100%; max-width: ${finalWidth}px; height: auto;" />`;
      }
    } catch (e) {
      return `<p style="color:red;">Error exporting image: ${altText}</p>`;
    }
    return "";
  }

  public async parse(nodes: readonly SceneNode[], imageExportMode: ImageExportMode): Promise<string> {
    if (nodes.length === 0) return "";
    this.imageAssets = [];
    this.imageCounter = 0;
    const rootBgColor = { r: 1, g: 1, b: 1 };
    
    if (nodes.length === 1) {
      const node = nodes[0];
      const isRootSelection = (node.parent?.type === 'PAGE');
      if (node.type === "FRAME" || node.type === "COMPONENT" || node.type === "INSTANCE") {
        return this.renderContainer(node, node.width, rootBgColor, isRootSelection, imageExportMode);
      } else {
        return this.renderNode(node, node.width, rootBgColor, imageExportMode);
      }
    }

    const sortedNodes = [...nodes].sort((a, b) => a.y - b.y);
    const rows: string[] = [];
    let lastBottomY = sortedNodes[0].y; 

    for (const [i, node] of sortedNodes.entries()) {
      if (i > 0) {
        const gap = Math.round(node.y - lastBottomY);
        if (gap > 2) rows.push(`<tr><td height="${gap}" style="height:${gap}px; font-size:${gap}px; line-height:${gap}px;">&nbsp;</td></tr>`);
      }
      
      const nodeHtml = await this.renderNode(node, node.width, rootBgColor, imageExportMode);
      
      if (nodeHtml.trim()) {
        rows.push(`<tr><td>${nodeHtml}</td></tr>`);
      }
      if (node.visible) {
        lastBottomY = node.y + node.height;
      }
    }
    
    return rows.join('');
  }
}

function isBulletPoint(node: SceneNode): node is FrameNode {
  if (node.type !== 'FRAME' || !node.visible || node.layoutMode !== 'HORIZONTAL' || !("children" in node) || node.children.length !== 2) return false;
  const [firstChild, secondChild] = node.children;
  if (firstChild.type !== 'TEXT' || secondChild.type !== 'TEXT') return false;
  const bulletChar = firstChild.characters.trim();
  return bulletChar.length === 1 && bulletChar in bulletCharacterMap;
}

figma.showUI(__html__, { width: 400, height: 480 });

async function processSelection(imageExportMode: ImageExportMode) {
  const selectedNodes = figma.currentPage.selection;
  if (selectedNodes.length === 0) {
    figma.notify("Please select at least one element.");
    figma.ui.postMessage({ type: 'generated-html', payload: { html: '', assets: [] } });
    return;
  }

  await collectAndLoadAllFonts(selectedNodes);

  const parser = new FigmaPluginParser();
  const html = await parser.parse(selectedNodes, imageExportMode);
  
  figma.ui.postMessage({ 
    type: 'generated-html', 
    payload: {
      html,
      assets: parser.getCollectedImageAssets(),
    }
  });
};

figma.ui.onmessage = async (msg: { type: string, payload: any }) => {
  if (msg.type === 'generate-html-for-selection') {
    await processSelection(msg.payload.imageExportMode);
  }
};