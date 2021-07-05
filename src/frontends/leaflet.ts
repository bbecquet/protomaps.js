declare var L: any

import Point from '@mapbox/point-geometry'
import { ZxySource, PmtilesSource, TileCache } from '../tilecache'
import { View } from '../view'
import { painter } from '../painter'
import { Labelers } from '../labeler'
import { paint_rules as lightPaintRules, label_rules as lightLabelRules } from '../default_style/light'
import { paint_rules as darkPaintRules, label_rules as darkLabelRules } from '../default_style/dark'

class CanvasPool {
    unused: any[]
    lang: string

    constructor(lang:string) {
        this.lang = lang
        this.unused = []
    }

    public get(tile_size) {
        if (this.unused.length) {
            let tile = this.unused.shift()
            tile.removed = false
            return tile
        }
        let element = L.DomUtil.create('canvas', 'leaflet-tile')
        element.width = tile_size
        element.height = tile_size
        element.lang = this.lang
        return element
    }

    public put(elem) {
        L.DomUtil.removeClass(elem,'leaflet-tile-loaded')
        this.unused.push(elem)
    }
}

class LeafletLayer extends L.GridLayer {
    constructor(options) {
        if (options.noWrap && !options.bounds) options.bounds = [[-90,-180],[90,180]]
        super(options)
        this.paint_rules = options.paint_rules || (options.dark ? darkPaintRules : lightPaintRules)
        this.label_rules = options.label_rules || (options.dark ? darkLabelRules : lightLabelRules)
        this.lastRequestedZ = undefined

        let source
        if (options.url.url) {
            source = new PmtilesSource(options.url)
        } else if (options.url.endsWith(".pmtiles")) {
            source = new PmtilesSource(options.url)
        } else {
            source = new ZxySource(options.url)
        }

        this.tasks = options.tasks || []
        let cache = new TileCache(source,1024)
        this.view = new View(cache,14,2)
        this.debug = options.debug
        let scratch = document.createElement('canvas').getContext('2d')
        this.scratch = scratch
        this.onTilesInvalidated = tiles => {
            tiles.forEach(t => {
                this.rerenderTile(t)
            })
        }
        this.labelers = new Labelers(this.scratch, this.label_rules, this.onTilesInvalidated)
        this.tile_size = 256 *window.devicePixelRatio
        this.pool = new CanvasPool(options.lang)
    }

    public setDefaultStyle(dark:boolean) {
        this.paint_rules = (dark ? darkPaintRules : lightPaintRules)
        this.label_rules = (dark ? darkLabelRules : lightLabelRules)
    }

    public async renderTile(coords,element,key,done = ()=>{}) {
        this.lastRequestedZ = coords.z
        let state = {element:element,tile_size:this.tile_size,ctx:null}
        var prepared_tile
        try {
            prepared_tile = await this.view.getDisplayTile(coords)
        } catch (e) {
            if (e.name == "AbortError") return
            else throw e
        }
        await Promise.allSettled(this.tasks)

        if (this.lastRequestedZ !== coords.z) return

        let layout_time = await this.labelers.add(prepared_tile)

        let label_data = this.labelers.getIndex(prepared_tile.z)

        if (this.lastRequestedZ !== coords.z) return
        if (!this._map) return // the layer has been removed from the map

        let BUF = 16
        let bbox = [256*coords.x-BUF,256*coords.y-BUF,256*(coords.x+1)+BUF,256*(coords.y+1)+BUF]
        let origin = new Point(256*coords.x,256*coords.y)
        let painting_time = painter(state,key,[prepared_tile],label_data,this.paint_rules,bbox,origin,false,this.debug)

        if (this.debug) {
            let ctx = state.ctx
            if (!ctx) return
            let data_tile = prepared_tile.data_tile
            ctx.save()
            ctx.fillStyle = this.debug
            ctx.font = '600 12px sans-serif'
            ctx.fillText(coords.z + " " + coords.x + " " + coords.y,4,14)
            ctx.font = '200 12px sans-serif'
            if ((data_tile.x % 2 + data_tile.y % 2) % 2 == 0) {
                ctx.font = '200 italic 12px sans-serif'
            }
            ctx.fillText(data_tile.z + " " + data_tile.x + " " + data_tile.y,4,28)
            ctx.font = '600 10px sans-serif'
            if (painting_time > 8) {
                ctx.fillText(painting_time.toFixed() + " ms paint",4,42)
            }
            if (layout_time > 8) {
                ctx.fillText(layout_time.toFixed() + " ms layout",4,56)
            }
            ctx.strokeStyle = this.debug
            ctx.lineWidth = 0.5
            ctx.strokeRect(0,0,256,256)
            ctx.restore()
        }
        done()
    }

    public rerenderTile(key) {
        for (let unwrapped_k in this._tiles) {
            let wrapped_coord = this._wrapCoords(this._keyToTileCoords(unwrapped_k))
            if (key === this._tileCoordsToKey(wrapped_coord)) {
                this.renderTile(wrapped_coord,this._tiles[unwrapped_k].el,key)
            }
        }
    }

    public clearLayout() {
        this.labelers = new Labelers(this.scratch, this.label_rules, this.onTilesInvalidated)
    }

    public rerenderTiles() {
        for (let unwrapped_k in this._tiles) {
            let wrapped_coord = this._wrapCoords(this._keyToTileCoords(unwrapped_k))
            let key = this._tileCoordsToKey(wrapped_coord)
            this.renderTile(wrapped_coord,this._tiles[unwrapped_k].el,key)
        }
    }

    public createTile(coords,showTile) {
        let element = this.pool.get(this.tile_size)
        let key = this._tileCoordsToKey(coords)
        element.key = key

        this.renderTile(coords,element,key,() => {
            showTile(null,element)
        })

        return element
    }

    public _removeTile(key) {
        let tile = this._tiles[key]
        if (!tile) { return }
        tile.el.removed = true
        tile.el.key = undefined
        L.DomUtil.remove(tile.el)
        this.pool.put(tile.el)
        delete this._tiles[key]
        this.fire('tileunload', {
            tile: tile.el,
            coords: this._keyToTileCoords(key)
        })
    }

    public queryFeatures(lng:number,lat:number) {
        return this.view.queryFeatures(lng,lat,this._map.getZoom())
    }
}

const leafletLayer = options => {
    return new LeafletLayer(options)
}

export { leafletLayer, LeafletLayer }