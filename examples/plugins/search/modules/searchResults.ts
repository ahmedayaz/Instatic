/**
 * pagebuilder.search.search-results module
 *
 * Full-page search results list. Reads ?q= from the URL on the published
 * page, calls the Search plugin endpoint, and renders results with pagination.
 *
 * No React — self-contained HTML/JS output.
 */
import { control, defineModule, html } from '@core/plugin-sdk'

export default defineModule({
  id: 'pagebuilder.search.search-results',
  name: 'Search Results',
  description: 'Full-page search results list with pagination. Drop on a page at /search.',
  category: 'Search',
  version: '1.0.0',
  htmlTag: 'section',
  canHaveChildren: false,
  defaults: {
    perPage: 10,
    noResultsMessage: 'No results found. Try a different search term.',
  },
  schema: {
    perPage: control.number('Results per page', {
      min: 1,
      max: 50,
      description: 'How many results to show per page.',
    }),
    noResultsMessage: control.textarea('No-results message', {
      rows: 2,
      description: 'Shown when the query returns zero hits.',
    }),
  },
  render: ({ props }) => {
    const perPage = Number(props.perPage ?? 10)
    const noResultsMessage = String(props.noResultsMessage ?? 'No results found.')

    const css = `
      .pb-search-results{font-family:inherit;max-width:720px;margin:0 auto;padding:24px 0;}
      .pb-search-results__query{margin-bottom:24px;}
      .pb-search-results__query-form{display:flex;gap:8px;}
      .pb-search-results__query-input{flex:1;padding:10px 14px;border:1px solid var(--pb-sr-border,#d1d5db);border-radius:6px;font-size:1rem;font-family:inherit;background:var(--pb-sr-bg,#fff);color:inherit;outline:none;box-sizing:border-box;}
      .pb-search-results__query-input:focus{border-color:var(--pb-sr-accent,#2563eb);box-shadow:0 0 0 3px var(--pb-sr-focus-ring,rgba(37,99,235,0.2));}
      .pb-search-results__query-btn{padding:10px 20px;background:var(--pb-sr-accent,#2563eb);color:#fff;border:none;border-radius:6px;font-size:1rem;font-family:inherit;cursor:pointer;}
      .pb-search-results__query-btn:hover{opacity:0.9;}
      .pb-search-results__meta{font-size:0.875rem;color:var(--pb-sr-muted,#6b7280);margin-bottom:16px;}
      .pb-search-results__list{list-style:none;padding:0;margin:0;}
      .pb-search-results__item{padding:16px 0;border-bottom:1px solid var(--pb-sr-border,#e5e7eb);}
      .pb-search-results__item:last-child{border-bottom:none;}
      .pb-search-results__item-title{font-size:1.1rem;font-weight:600;margin:0 0 4px;}
      .pb-search-results__item-title a{color:var(--pb-sr-accent,#2563eb);text-decoration:none;}
      .pb-search-results__item-title a:hover{text-decoration:underline;}
      .pb-search-results__item-slug{font-size:0.8rem;color:var(--pb-sr-muted,#6b7280);margin:0 0 6px;}
      .pb-search-results__item-excerpt{font-size:0.9rem;color:var(--pb-sr-text,inherit);margin:0;line-height:1.5;}
      .pb-search-results__empty{padding:24px;text-align:center;color:var(--pb-sr-muted,#6b7280);}
      .pb-search-results__pagination{display:flex;align-items:center;gap:8px;margin-top:24px;flex-wrap:wrap;}
      .pb-search-results__page-btn{padding:6px 14px;border:1px solid var(--pb-sr-border,#d1d5db);border-radius:4px;background:var(--pb-sr-bg,#fff);color:inherit;cursor:pointer;font-family:inherit;font-size:0.875rem;}
      .pb-search-results__page-btn:hover:not(:disabled){background:var(--pb-sr-hover,#f3f4f6);}
      .pb-search-results__page-btn:disabled{opacity:0.5;cursor:default;}
      .pb-search-results__page-btn.is-current{background:var(--pb-sr-accent,#2563eb);color:#fff;border-color:var(--pb-sr-accent,#2563eb);}
      .pb-search-results__loading{text-align:center;padding:32px;color:var(--pb-sr-muted,#6b7280);}
    `

    const script = `
(function(){
  var ENDPOINT='/admin/api/cms/plugins/pagebuilder.search/runtime/search';
  var PER_PAGE=${perPage};
  var NO_RESULTS_MSG=${JSON.stringify(noResultsMessage)};

  function getParam(name){
    var params=new URLSearchParams(window.location.search);
    return params.get(name)||'';
  }

  function escHtml(s){
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }
  function safeHref(slug){
    return(slug.startsWith('/')||slug.startsWith('https://')||slug.startsWith('http://'))?slug:'#';
  }

  function setParam(name,value){
    var params=new URLSearchParams(window.location.search);
    if(value){params.set(name,value);}else{params.delete(name);}
    var newUrl=window.location.pathname+'?'+params.toString();
    window.history.replaceState(null,'',newUrl);
  }

  function renderMeta(q,total,tookMs,page){
    var meta=document.querySelector('.pb-search-results__meta');
    if(!meta)return;
    if(!q){meta.textContent='Enter a search term above.';return;}
    var from=(page-1)*PER_PAGE+1;
    var to=Math.min(page*PER_PAGE,total);
    meta.textContent=total>0
      ?('Showing '+from+'–'+to+' of '+total+' results for "'+q+'" ('+tookMs+'ms)')
      :('No results for "'+q+'"');
  }

  function renderResults(hits){
    var list=document.querySelector('.pb-search-results__list');
    if(!list)return;
    list.innerHTML='';
    if(!hits||hits.length===0){
      var empty=document.createElement('div');
      empty.className='pb-search-results__empty';
      empty.textContent=NO_RESULTS_MSG;
      list.parentNode.insertBefore(empty,list);
      return;
    }
    hits.forEach(function(h){
      var li=document.createElement('li');
      li.className='pb-search-results__item';
      li.innerHTML=(
        '<h2 class="pb-search-results__item-title"><a href="'+safeHref(h.slug)+'">'+escHtml(h.title)+'</a></h2>'
        +'<p class="pb-search-results__item-slug">'+escHtml(h.slug)+'</p>'
        +(h.excerpt?'<p class="pb-search-results__item-excerpt">'+escHtml(h.excerpt)+'</p>':'')
      );
      list.appendChild(li);
    });
  }

  function renderPagination(total,currentPage){
    var container=document.querySelector('.pb-search-results__pagination');
    if(!container)return;
    container.innerHTML='';
    var totalPages=Math.ceil(total/PER_PAGE);
    if(totalPages<=1)return;

    function pageBtn(label,page,isCurrent,disabled){
      var btn=document.createElement('button');
      btn.className='pb-search-results__page-btn'+(isCurrent?' is-current':'');
      btn.textContent=label;
      btn.disabled=disabled||false;
      if(!disabled&&!isCurrent){
        btn.addEventListener('click',function(){doSearch(getParam('q'),page);});
      }
      return btn;
    }

    container.appendChild(pageBtn('← Prev',currentPage-1,false,currentPage===1));

    var start=Math.max(1,currentPage-2);
    var end=Math.min(totalPages,currentPage+2);
    if(start>1){
      container.appendChild(pageBtn('1',1,false,false));
      if(start>2){var ell=document.createElement('span');ell.textContent='…';container.appendChild(ell);}
    }
    for(var p=start;p<=end;p++){
      container.appendChild(pageBtn(String(p),p,p===currentPage,false));
    }
    if(end<totalPages){
      if(end<totalPages-1){var ell2=document.createElement('span');ell2.textContent='…';container.appendChild(ell2);}
      container.appendChild(pageBtn(String(totalPages),totalPages,false,false));
    }
    container.appendChild(pageBtn('Next →',currentPage+1,false,currentPage>=totalPages));
  }

  function showLoading(){
    var list=document.querySelector('.pb-search-results__list');
    var empty=document.querySelector('.pb-search-results__empty');
    if(empty&&empty.parentNode)empty.parentNode.removeChild(empty);
    if(list)list.innerHTML='<li class="pb-search-results__loading">Loading…</li>';
  }

  function doSearch(q,page){
    page=page||1;
    setParam('q',q);
    setParam('page',String(page));
    if(!q){renderMeta('',0,0,1);renderResults([]);renderPagination(0,1);return;}
    showLoading();
    fetch(ENDPOINT+'?q='+encodeURIComponent(q)+'&page='+page+'&per-page='+PER_PAGE)
      .then(function(r){return r.json();})
      .then(function(body){
        renderMeta(q,body.total||0,body.took_ms||0,page);
        renderResults(body.results||[]);
        renderPagination(body.total||0,page);
      })
      .catch(function(err){
        var list=document.querySelector('.pb-search-results__list');
        if(list)list.innerHTML='<li class="pb-search-results__empty">Search unavailable. Please try again.</li>';
      });
  }

  // Wire up the form.
  var form=document.querySelector('.pb-search-results__query-form');
  if(form){
    var input=form.querySelector('.pb-search-results__query-input');
    form.addEventListener('submit',function(e){
      e.preventDefault();
      doSearch((input&&input.value)||'',1);
    });
  }

  // Run initial search from URL.
  var q=getParam('q');
  var page=parseInt(getParam('page'),10)||1;
  if(input&&q)input.value=q;
  doSearch(q,page);
})();
`

    return {
      html: html`
        <section class="pb-search-results">
          <div class="pb-search-results__query">
            <form class="pb-search-results__query-form" role="search">
              <input
                class="pb-search-results__query-input"
                type="search"
                placeholder="Search…"
                aria-label="Search"
                autocomplete="off"
              />
              <button class="pb-search-results__query-btn" type="submit">Search</button>
            </form>
          </div>
          <div class="pb-search-results__meta"></div>
          <ul class="pb-search-results__list" aria-live="polite" aria-label="Search results"></ul>
          <nav class="pb-search-results__pagination" aria-label="Pagination"></nav>
          <script>${script}</script>
        </section>
      `,
      css,
    }
  },
})
