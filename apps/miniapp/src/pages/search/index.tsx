/**
 * 体检一个地点: an address, a compound's name or the phone's own position becomes the centre of a
 * live check (GET /api/locate, then POST /api/analyze back on the map screen). The recent live checks
 * and the samples are one tap away; a sample-mode server only opens those.
 */
import { Input, ScrollView, Text, View } from '@tarojs/components';
import Taro from '@tarojs/taro';
import { useEffect, useRef, useState } from 'react';
import { parseCoords } from '@web/data/coords';
import { locate, locateCoords, type LocateCandidate } from '@web/data/locate';
import { areaOptions } from '@web/model/areas';
import { Icon } from '../../platform/Icons';
import * as store from '../../state/store';
import './index.css';

type Found =
  | { status: 'idle' }
  | { status: 'busy' }
  | { status: 'list'; items: LocateCandidate[]; confirm: boolean }
  | { status: 'none'; message: string };

export default function SearchPage() {
  const s = store.useStore();
  const shown = store.shown(s);
  const live = s.health?.mode === 'live';
  const [q, setQ] = useState('');
  const [found, setFound] = useState<Found>({ status: 'idle' });
  const coords = parseCoords(q);
  // dev builds only: the capture script types into the box through getApp().__zdd.type(text)
  useEffect(() => {
    if (process.env.NODE_ENV === 'production') return;
    const app = Taro.getApp<{ __zdd?: Record<string, unknown> }>();
    app.__zdd = {
      ...(app.__zdd ?? {}),
      type: (t: string) => setQ(t),
      go: () => search(),
      choose: (i = 0) => {
        if (found.status === 'list' && found.items[i]) check(found.items[i]!);
      },
    };
  });
  const ctl = useRef<AbortController | null>(null);

  const check = (c: LocateCandidate) => {
    if (!live) {
      Taro.showToast({ title: '服务端为样例模式，只能看样例', icon: 'none' });
      return;
    }
    store.startAnalysis(c);
    Taro.navigateBack().catch(() => Taro.reLaunch({ url: '/pages/index/index' }));
  };

  const search = () => {
    const text = q.trim();
    if (!text) return;
    if (coords) {
      if (!coords.ok) {
        setFound({ status: 'none', message: '这对数字不在中国境内的经纬度范围里' });
        return;
      }
      setFound({ status: 'busy' });
      // coordinates are Baidu's own (BD-09): the analysis runs on Baidu's frame, nothing to convert
      locateCoords(coords.lng, coords.lat, 'bd09')
        .then((r) => {
          if (r.kind === 'coordinate') setFound({ status: 'list', items: [r.point], confirm: false });
          else
            setFound({ status: 'none', message: r.kind === 'unavailable' ? r.message : '坐标没有换算成功' });
        })
        .catch(() => setFound({ status: 'none', message: '连不上邻至服务端' }));
      return;
    }
    ctl.current?.abort();
    const c = new AbortController();
    ctl.current = c;
    setFound({ status: 'busy' });
    locate(text, c.signal)
      .then((r) => {
        if (c.signal.aborted) return;
        if (r.kind === 'sample') {
          store.openSample(r.id);
          Taro.navigateBack().catch(() => {});
        } else if (r.kind === 'place')
          setFound({ status: 'list', items: r.candidates, confirm: r.needsConfirmation });
        else if (r.kind === 'coordinate') setFound({ status: 'list', items: [r.point], confirm: false });
        else if (r.kind === 'none')
          setFound({
            status: 'none',
            message: r.warnings[0] ?? `没有找到“${text}”，换个说法试试，比如加上街道或区名`,
          });
        else setFound({ status: 'none', message: r.message });
      })
      .catch(() => !c.signal.aborted && setFound({ status: 'none', message: '连不上邻至服务端' }));
  };

  const mine = () => {
    Taro.getLocation({ type: 'gcj02' })
      .then(({ longitude, latitude }) => {
        setFound({ status: 'busy' });
        return locateCoords(longitude, latitude, 'gcj02');
      })
      .then((r) => {
        if (r.kind !== 'coordinate') {
          setFound({ status: 'none', message: r.kind === 'unavailable' ? r.message : '没有取到位置' });
          return;
        }
        check({ ...r.point, name: '我的位置附近' });
      })
      .catch(() => Taro.showToast({ title: '没有拿到位置：请在设置里允许使用位置', icon: 'none' }));
  };

  const { live: recent, samples } = shown
    ? areaOptions({
        // the opening sample first: the one the demo starts from
        samples: [...shown.loaded.samples].sort(
          (a, b) => Number(b.id === store.OPENING_SAMPLE) - Number(a.id === store.OPENING_SAMPLE),
        ),
        history: s.history,
        active: shown.live ? null : shown.loaded.id,
        activeLive: shown.live ? shown.analysisId : null,
        current: { code: shown.model.code, name: shown.model.data.meta.name, live: shown.live },
        onOpen: (id) => {
          store.openSample(id);
          Taro.navigateBack().catch(() => {});
        },
        onOpenHistory: (h) => {
          store.openHistory(h);
          Taro.navigateBack().catch(() => {});
        },
      })
    : { live: [], samples: [] };

  return (
    <View className="search">
      <View className="s-bar">
        <View className="s-input">
          <Icon id="ui-search" color="#7A828E" size={17} />
          <Input
            className="s-field"
            value={q}
            confirmType="search"
            placeholder="地址、小区，或百度坐标如 121.644, 31.190"
            placeholderClass="s-ph"
            maxlength={60}
            onInput={(e) => setQ(e.detail.value)}
            onConfirm={search}
          />
        </View>
        <View className="s-go" onClick={search} hoverClass="pressed">
          <Text>搜索</Text>
        </View>
      </View>
      {coords?.ok ? (
        <Text className="s-crs">
          百度坐标 {coords.lng.toFixed(6)}, {coords.lat.toFixed(6)}
          {coords.swapped ? '（已按纬度在前读取）' : ''}
        </Text>
      ) : null}
      <ScrollView scrollY className="s-body">
        <View className="s-mine" onClick={mine} hoverClass="row-pressed">
          <View className="s-mine-ico">
            <Icon id="ui-locate" color="#FFFFFF" size={18} />
          </View>
          <View className="s-mine-text">
            <Text className="s-mine-t">体检我所在的位置</Text>
            <Text className="s-mine-n">看看 15 分钟能走到哪些餐馆、超市、菜场和医院</Text>
          </View>
          <Icon id="ui-right" color="#C2C7CF" size={14} />
        </View>
        {!live ? (
          <Text className="s-note">
            服务端当前是样例模式：可以看下面的样例，新地点需要接入百度 Key 后体检。
          </Text>
        ) : null}

        {found.status === 'busy' ? <Text className="s-note">正在查找…</Text> : null}
        {found.status === 'none' ? <Text className="s-note">{found.message}</Text> : null}
        {found.status === 'list' ? (
          <>
            <Text className="s-h">{found.confirm ? '找到几个可能的地点，选一个' : '找到的地点'}</Text>
            {found.items.map((c, i) => (
              <View
                key={`${c.name}-${i}`}
                className="s-row"
                onClick={() => check(c)}
                hoverClass="row-pressed"
              >
                <Icon id="ui-pin" color="#2468F2" size={20} />
                <View className="s-row-text">
                  <Text className="s-row-t">{c.name}</Text>
                  {c.address ? <Text className="s-row-n">{c.address}</Text> : null}
                </View>
                <Text className="s-row-go">体检</Text>
              </View>
            ))}
          </>
        ) : null}

        {/* once the user types, the search is what the page is about */}
        {recent.length && !q.trim() ? <Text className="s-h">最近的体检</Text> : null}
        {(q.trim() ? [] : recent).map((o) => (
          <View key={o.key} className="s-row" onClick={o.open ?? undefined} hoverClass="row-pressed">
            <Text className="s-code num live">实时</Text>
            <View className="s-row-text">
              <Text className="s-row-t">{o.name}</Text>
              {o.note ? <Text className="s-row-n">{o.note}</Text> : null}
            </View>
          </View>
        ))}
        <Text className="s-h">样例 · 百度实测存档</Text>
        {samples.map((o) => (
          <View key={o.key} className="s-row" onClick={o.open ?? undefined} hoverClass="row-pressed">
            <Text className="s-code num">{o.code}</Text>
            <View className="s-row-text">
              <Text className="s-row-t">{o.name}</Text>
              {o.note ? <Text className="s-row-n">{o.note}</Text> : null}
            </View>
            {o.current ? <Icon id="pg-check" color="#2468F2" size={16} /> : null}
          </View>
        ))}
        <View className="s-end" />
      </ScrollView>
    </View>
  );
}
