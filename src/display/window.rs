#![allow(unused_mut)]
#![allow(unused_imports)]
#![allow(unused_variables)]
#![allow(dead_code)]
use std::time::{Instant, Duration};
use neon::prelude::*;
use neon::result::Throw;
use crossbeam::channel::Sender;
use skia_safe::{Color, Matrix};
use glutin::platform::run_return::EventLoopExtRunReturn;
use glutin::event_loop::{ControlFlow, EventLoop, EventLoopProxy, EventLoopClosed};
use glutin::event::{Event, WindowEvent};
use glutin::dpi::{LogicalSize, PhysicalSize, LogicalPosition};
use glutin::window::CursorIcon;

use crate::canvas::Page;
use crate::context::BoxedContext2D;
use crate::utils::{argv, color_arg, float_arg, to_cursor_icon, to_canvas_fit};
use super::{CanvasEvent, View, Fit};
use super::event;

pub struct Window{
  proxy: EventLoopProxy<CanvasEvent>,
  position: LogicalPosition<i32>,
  size: LogicalSize<u32>,
  ui_events: event::Sieve,
  js_events: Option<Sender<CanvasEvent>>,

  title: String,
  cursor: Option<CursorIcon>,
  fit: Option<Fit>,
  dpr: f64,

  fullscreen: bool,
  visible: bool,
  animated: bool,
  fps: u64,
}


impl Window{
  pub fn new(runloop:&EventLoop<CanvasEvent>, width:f32, height:f32) -> Self {
    Window{
      proxy: runloop.create_proxy(),
      position: LogicalPosition::new(0,0),
      size: LogicalSize::new(width as u32, height as u32),
      ui_events: event::Sieve::new(),
      js_events: None,

      title: "".to_string(),
      cursor: Some(CursorIcon::Default),
      fit: Some(Fit::Contain{x:false, y:true}),
      dpr: 1.0,
      fps: 0,

      visible:false,
      animated: false,
      fullscreen: false,
    }
  }

  pub fn new_view(&mut self, runloop:&EventLoop<CanvasEvent>, c2d:Handle<BoxedContext2D>, backdrop:Option<Color>) -> View {
    let (s, r) = crossbeam::channel::unbounded::<CanvasEvent>();
    let mut view = View::new(&runloop, c2d, r, backdrop, self.size.width as f32, self.size.height as f32);
    self.js_events = Some(s);
    self.dpr = view.dpr();
    view
  }

  pub fn show(&self){
    self.proxy.send_event(CanvasEvent::Visible(true)).ok();
  }

  pub fn render(&self){
    self.proxy.send_event(CanvasEvent::Render).ok();
  }

  pub fn went_fullscreen(&mut self, is_fullscreen:bool){
    // should only be triggered when the fullscreen transition is detected in the view (i.e. via a window widget)
    if is_fullscreen !=self.fullscreen{
      self.fullscreen = is_fullscreen;
      self.ui_events.go_fullscreen(is_fullscreen);
    }
  }

  pub fn new_transform(&mut self, new_matrix:Option<Matrix>){
    if let Some(matrix) = new_matrix{
      self.ui_events.use_transform(matrix);
    }
  }

  pub fn handle_event(&mut self, event:&Event<CanvasEvent>){
    if let Event::WindowEvent{event, ..} = event {
      if let WindowEvent::Resized(physical_size) = event {
        self.size = LogicalSize::from_physical(*physical_size, self.dpr);
        // self.proxy.send_event(CanvasEvent::Resized(*physical_size)).ok();
        if let Some(channel) = &self.js_events{
          channel.send(CanvasEvent::Resized(*physical_size)).unwrap();
        }
      }

      if let WindowEvent::Moved(physical_pt) = event {
        self.position = LogicalPosition::from_physical(*physical_pt, self.dpr);
      }

      self.ui_events.capture(&event, self.dpr)
    }
  }

  pub fn communicate_pending(&mut self, cx: &mut FunctionContext, callback:&Handle<JsFunction>) -> ControlFlow {
    match self.ui_events.is_empty(){
      true => ControlFlow::Poll,
      false => self.communicate(cx, callback)
    }
  }

  pub fn communicate(&mut self, cx: &mut FunctionContext, callback:&Handle<JsFunction>) -> ControlFlow {
    let changes = self.ui_events.serialized(cx);
    let null = cx.null();
    if let Ok(response) = callback.call(cx, null, changes){
      if self.handle_feedback(cx, response).is_ok(){
        return ControlFlow::Poll
      }
    }
    ControlFlow::Exit
  }

  pub fn handle_feedback(&mut self, cx:&mut FunctionContext, feedback:Handle<JsValue>) -> Result<(), EventLoopClosed<CanvasEvent>> {
    if let Ok(array) = feedback.downcast::<JsArray, _>(cx){
      if let Ok(vals) = array.to_vec(cx){

        // 0: context
        if let Ok(c2d) = vals[0].downcast::<BoxedContext2D, _>(cx){
          let page = c2d.borrow_mut().get_page();
          self.proxy.send_event(CanvasEvent::Page(page))?
        }

        // 1: title
        if let Ok(title) = vals[1].downcast::<JsString, _>(cx){
          let title = title.value(cx);
          if title != self.title{
            self.title = title.to_string();
            self.proxy.send_event(CanvasEvent::Title(title))?
          }
        }

        // 2: 'keep running' flag
        if let Ok(active) = vals[2].downcast::<JsBoolean, _>(cx){
          if !active.value(cx){
            self.proxy.send_event(CanvasEvent::Close)?
          }
        }

        // 3: fullscreen flag
        if let Ok(is_full) = vals[3].downcast::<JsBoolean, _>(cx){
          let is_full = is_full.value(cx);
          if is_full != self.fullscreen{
            self.fullscreen = is_full;
            if let Some(channel) = &self.js_events{
              channel.send(CanvasEvent::Fullscreen(is_full)).unwrap();
            }
            self.ui_events.go_fullscreen(is_full);
          }
        }

        // 4: fps (or zero to disable animation)
        if let Ok(fps) = vals[4].downcast::<JsNumber, _>(cx){
          let fps = fps.value(cx) as u64;
          if fps != self.fps{
            self.fps = fps;
            self.proxy.send_event(CanvasEvent::FrameRate(fps))?
          }
        }

        // 5+6: window size
        if let Ok(width) = vals[5].downcast::<JsNumber, _>(cx){
          if let Ok(height) = vals[6].downcast::<JsNumber, _>(cx){
            let size = LogicalSize::new( width.value(cx) as u32, height.value(cx) as u32 );
            if size != self.size{
              self.size = size;
              self.proxy.send_event(CanvasEvent::Size(size))?
            }
          }
        }

        // 7+8: window position
        if let Ok(x) = vals[7].downcast::<JsNumber, _>(cx){
          if let Ok(y) = vals[8].downcast::<JsNumber, _>(cx){
            let position = LogicalPosition::new( x.value(cx) as i32, y.value(cx) as i32 );
            if position != self.position{
              self.position = position;
              self.proxy.send_event(CanvasEvent::Position(position))?
            }
          }
        }

        // 9: cursor
        if let Ok(cursor_style) = vals[9].downcast::<JsString, _>(cx){
          let cursor_style = cursor_style.value(cx);
          let cursor_icon = to_cursor_icon(&cursor_style);
          if cursor_icon != self.cursor && cursor_icon.is_some() || cursor_style == "none"{
            self.cursor = cursor_icon;
            self.proxy.send_event(CanvasEvent::Cursor(cursor_icon))?
          }
        }

        // 10: fit
        if let Ok(fit_style) = vals[10].downcast::<JsString, _>(cx){
          let fit_style = fit_style.value(cx);
          let fit_mode = to_canvas_fit(&fit_style);
          if fit_mode != self.fit && fit_mode.is_some() || fit_style == "none"{
            self.fit = fit_mode;
            self.proxy.send_event(CanvasEvent::Fit(fit_mode))?
          }
        }

        // 11: visible flag
        if let Ok(is_visible) = vals[11].downcast::<JsBoolean, _>(cx){
          let is_visible = is_visible.value(cx);
          if is_visible != self.visible{
            self.visible = is_visible;
            self.proxy.send_event(CanvasEvent::Visible(is_visible))?
          }
        }

      }
    }

    Ok(())
  }

}