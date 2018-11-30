window.ct = window.ct || {};

ct.offlineFirstListAPIDataLoader = class OfflineFirstListAPIDataLoader {

  constructor(url,headers, responseParser,pageSize,sortKeyGenerator,pouchDBName,listId) {
    if(!url || !pouchDBName){
      console.error('Required parameters are missing');
    }
    
    this._getUrl = url;
    this.headers = headers;
    this.responseParser = responseParser || this._defaultResponseParser;
    this.pageSize = pageSize;
    this.sortKeyGenerator = sortKeyGenerator;
    this.pouchDBName = pouchDBName;
    this.listId = listId || 'default';
    this._items = [];
    this._offlineListDataManager = new OfflineListDataManager(pouchDBName, sortKeyGenerator, listId);
  }

  /**
   * Used to load page from server
   */
  loadNextPage() {
    return new Promise((resolve, reject) => {
      let startKey = this._getStartKey();
      
      this._offlineListDataManager.readPage(this.pageSize,startKey).then(list => {
        if(list.items && list.items.length){
          this._items.push(...list.items);
          resolve();
          return;
        }
        
        this._loadPageFromServer().then(() => {
          resolve();
        });
      });
    });
  }

  /**
   * Called on items add/update
   *
   * @param {fn} callbackFn - Function to be called on items changes
   */
  spliceObserver(callbackFn) {
    this._offlineListDataManager.spliceObserver(callbackFn);
  }
  
  /**
   * Used to refresh list data
   */
  refresh(){
    let noOfFetchedPage = this._items.length / this.pageSize;
    noOfFetchedPage = Math.ceil(noOfFetchedPage);
    this._items = [];
    this._refreshListData(noOfFetchedPage);
  }

  _refreshListData(noOfPageToBeFetched, counter){
    var counter = counter || 0;
    this._loadPageFromServer().then(() => {
      counter++;
      if(counter < noOfPageToBeFetched){
        this._refreshListData(noOfPageToBeFetched, counter);
      };
    });
  }

  _getStartKey(){
    if(!this._items.length){
      return;
    }
    
    let lastItem = this._items[(this._items.length - 1)];
    return this.sortKeyGenerator(lastItem);
  }
  
  _defaultResponseParser(items){
    items.forEach(item => {
      item._id = item.id.toString();
    });
    
    return items;
  }
  
  _loadPageFromServer(){
    return new Promise((resolve, reject) => {
      let startKey = this._getStartKey() || null;
      let url = this._getUrl(this.pageSize, startKey);
      this._getHeaders().then(headers => {
        fetch(url, {
          headers: headers
        }).then((response) => {
            if (response.status !== 200) {
              console.error('Failed to toad page. Url: '+ url, response.status);
              return;
            }

            response.json().then((data) => {
              var parsedData = this.responseParser(data.rows);
              this._items.push(...parsedData);
              resolve(parsedData);
              this._offlineListDataManager.upsert(parsedData,startKey, parsedData.length < this.pageSize);
            });
          }).catch(function(err) {
             console.error('Failed to toad page. Url:'+ url, err);
             reject(err);
          });
      });
      
    });
  }
  
  _getHeaders(){
    return new Promise((resolve, reject) => {
      if(this.headers){
        this.headers().then(headers => {
          resolve(headers);
        });
        return;
      }
      
      resolve();
    });
  }

}