  private extractSection(md: string, possibleHeaders: string[]): string | null {
    for (const header of possibleHeaders) {
      const headerIndex = md.indexOf(header);
      if (headerIndex === -1) continue;
      
      // Find the end of this section (next ## or # header, or end of string)
      let sectionEnd = md.length;
      for (let i = headerIndex + header.length; i < md.length; i++) {
        if (md.substring(i, i + 3) === '\n##' || md.substring(i, i + 2) === '\n#') {
          sectionEnd = i;
          break;
        }
      }
      
      // Extract content after header (skip newline after header)
      let contentStart = headerIndex + header.length;
      while (contentStart < md.length && (md[contentStart] === '\n' || md[contentStart] === '\r')) {
        contentStart++;
      }
      
      const content = md.substring(contentStart, sectionEnd).trim();
      return content;
    }
    return null;
  }