import axios from 'axios';
import * as cheerio from 'cheerio';

export interface KaraokeNerdsTrack {
  title: string;
  artist: string;
  url: string;
  brand?: string;
  source: 'karaoke-nerds';
}

export async function searchKaraokeNerds(query: string): Promise<KaraokeNerdsTrack[]> {
  const q = query.trim();
  if (!q) return [];

  try {
    const params = new URLSearchParams();
    params.append('query', q);
    params.append('webFilter', 'OnlyWeb');

    const response = await axios.get<string>(`https://karaokenerds.com/Search?${params.toString()}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
      },
      timeout: 15000,
    });

    const $ = cheerio.load(response.data);
    const results: KaraokeNerdsTrack[] = [];
    let currentTitle = '';
    let currentArtist = '';

    $('table tbody tr').each((_i, row) => {
      const $row = $(row);

      if ($row.hasClass('group')) {
        currentTitle = $row.find('td').eq(0).find('a').first().text().trim()
          || $row.find('td').eq(0).text().trim();
        currentArtist = $row.find('td').eq(1).find('a').first().text().trim()
          || $row.find('td').eq(1).text().trim();
        return;
      }

      if (!$row.hasClass('details') || !currentTitle) return;
      $row.find('td ul li').each((_j, li) => {
        const $li = $(li);
        const brand = $li.find('a').first().text().trim();
        const youtubeUrl = $li.find('a[href*="youtube.com"]').first().attr('href')?.replace(/&amp;/g, '&').trim();
        if (!youtubeUrl) return;
        results.push({
          title: currentTitle,
          artist: currentArtist || 'Unknown Artist',
          url: youtubeUrl,
          brand: brand || undefined,
          source: 'karaoke-nerds',
        });
      });
    });

    return results.slice(0, 2000);
  } catch (error: any) {
    console.warn(`[gateway] KaraokeNerds search failed: ${error.message}`);
    return [];
  }
}
